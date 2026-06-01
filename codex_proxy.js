#!/usr/bin/env node
/**
 * Codex CLI Responses API → DeepSeek Chat Completions API proxy
 *
 * Translates the OpenAI Responses API (used by Codex CLI v0.135.0)
 * to DeepSeek's /v1/chat/completions API, including tool call support.
 *
 * v7 — 修复裁剪孤儿工具消息 + req.on('close')作用域：
 *   - autoTrim 裁剪后自动跳过开头的孤儿 tool 消息，确保 assistant(tc) → tool 配对
 *   - req.on('close') 移到 req.on('end') 内部，修复 dsReq 作用域崩溃
 *   - v6 保守 token 估算 + v5 健壮性 保留
 */

const http = require('http');
const https = require('https');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error('[FATAL] OPENAI_API_KEY environment variable is required');
  process.exit(1);
}
const HOST = 'api.deepseek.com';
const CHAT_PATH = '/v1/chat/completions';
const PORT = 15722;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId() {
  return 'resp_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
function itemId() {
  return 'item_' + Math.random().toString(36).substring(2, 15);
}
function callId() {
  return 'call_' + Math.random().toString(36).substring(2, 15);
}

function sse(res, event, data) {
  try {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (e) {
    console.error('[SSE_WRITE_ERR]', e.message);
  }
}

function sendJsonErr(res, code, msg) {
  console.error('[ERR]', code, msg);
  try {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: msg, type: 'proxy_error' } }));
  } catch (e) {
    console.error('[FATAL] Could not send error response:', e.message);
  }
}

function sendSseErr(res, msg, codexFriendly) {
  console.error('[SSE_ERR]', msg);
  // 发送 error 事件（Codex 可能不处理，但保留兼容性）
  sse(res, 'error', {
    type: 'error',
    error: { message: msg, type: 'proxy_error', code: codexFriendly || 'error' }
  });
  // 发送 response.completed 告知 Codex 本轮失败
  const rid = makeId();
  // 附上报错信息到 output，让 Codex 有机会展示给用户
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: rid,
      object: 'response',
      status: 'failed',
      model: '',
      output: [{
        id: itemId(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '⚠️ 代理错误: ' + msg }]
      }],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    }
  });
  try { res.end(); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Extract text content from a Responses API content array
// ---------------------------------------------------------------------------
function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
      .map(c => c.text || '')
      .join('');
  }
  if (content.text) return content.text;
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Translate Responses API input items -> Chat Completions messages array
// ---------------------------------------------------------------------------

// 从 reasoning item 提取文本
function extractReasoningText(item) {
  if (item.summary && Array.isArray(item.summary)) {
    return item.summary.map(s => s.text || '').join('');
  }
  if (item.content) {
    return extractTextFromContent(item.content);
  }
  return '';
}

// 生成一个 fallback tool_call_id（当 call_id 缺失时）
let _fallbackIdx = 0;
function fallbackCallId() {
  return 'fallback_call_' + (++_fallbackIdx) + '_' + Math.random().toString(36).substring(2, 8);
}

/**
 * 核心翻译：Codex Responses API input items → DeepSeek Chat Completions messages
 *
 * Codex 的 input 是扁平 item 列表，每个 tool call / tool result / message 都是独立 item。
 * DeepSeek 要求严格的 assistant(tool_calls) → tool → tool  配对。
 *
 * 策略：
 *   - 连续的 function_call item 累积到 pendingToolCalls
 *   - 遇到第一个 function_call_output 时，先将 pendingToolCalls 合并成一个 assistant(tc:N) 消息 flush
 *   - reasoning_content 必须放在有 tool_calls 的 assistant 上（DeepSeek V4 强制要求）
 *   - 如果 function_call 前有一个 text-only assistant，将其文本和 reasoning 合并到 tool_calls assistant 里
 */
function translateInput(input) {
  if (!Array.isArray(input)) {
    return [{ role: 'user', content: String(input) }];
  }

  const messages = [];
  let pendingReasoning = '';
  const pendingToolCalls = [];       // 累积的 function_call 项

  // flushPendingToolCalls — 将所有累积的 function_call 合并成一条 assistant(tc:N) 消息
  function flushPendingToolCalls() {
    if (pendingToolCalls.length === 0) return;

    // 构建合并后的 tool_calls 数组
    const mergedToolCalls = pendingToolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: tc.function
    }));

    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: mergedToolCalls
    };

    // reasoning_content 必须在此 assistant 上
    if (pendingReasoning) {
      msg.reasoning_content = pendingReasoning;
      pendingReasoning = '';
    }

    // 检查前一条消息：如果是 assistant（text-only），把它合并进来
    if (messages.length > 0) {
      const prev = messages[messages.length - 1];
      if (prev.role === 'assistant' && !prev.tool_calls) {
        // 将文本内容提升到 tool_calls assistant
        if (prev.content) {
          msg.content = prev.content;
        }
        // 如果前一条有 reasoning_content，也合并
        if (prev.reasoning_content) {
          msg.reasoning_content = (msg.reasoning_content || '') + prev.reasoning_content;
        }
        messages.pop(); // 移除 text-only assistant
      }
    }

    messages.push(msg);
    pendingToolCalls.length = 0;
    console.log('[MERGE] flushed', mergedToolCalls.length, 'tool_calls into single assistant message');
  }

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || !item.type) {
      console.warn('[WARN] input item missing type at index', i, '— skipping');
      continue;
    }

    switch (item.type) {

      // ---- reasoning ----
      case 'reasoning': {
        pendingReasoning = (pendingReasoning || '') + extractReasoningText(item);
        break;
      }

      // ---- message (user / assistant / developer) ----
      case 'message': {
        const role = item.role || 'user';
        const mappedRole = role === 'developer' ? 'system' : role;

        if (mappedRole === 'assistant') {
          // 遇到新的 assistant 消息 → 先 flush 之前的 tool_calls（如果有）
          flushPendingToolCalls();

          let text = '';
          const toolCalls = [];

          if (Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === 'output_text' || c.type === 'text') {
                text += c.text || '';
              } else if (c.type === 'tool_use' || c.type === 'tool_call') {
                toolCalls.push({
                  id: c.id || callId(),
                  type: 'function',
                  function: {
                    name: c.name || '',
                    arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {})
                  }
                });
              } else if (c.type === 'reasoning_summary') {
                pendingReasoning = (pendingReasoning || '') + (c.text || '');
              }
            }
          } else if (typeof item.content === 'string') {
            text = item.content;
          }

          if (toolCalls.length > 0) {
            // assistant 里已嵌有 tool_calls → 直接使用
            const msg = { role: 'assistant', content: text || null, tool_calls: toolCalls };
            if (pendingReasoning) {
              msg.reasoning_content = pendingReasoning;
              pendingReasoning = '';
            }
            messages.push(msg);
          } else {
            // text-only assistant — 推入暂存，后续 function_call 可能会合并它
            const msg = { role: 'assistant', content: text || '' };
            if (pendingReasoning) {
              msg.reasoning_content = pendingReasoning;
              pendingReasoning = '';
            }
            messages.push(msg);
          }
        } else {
          // user / system → 先 flush tool_calls
          flushPendingToolCalls();
          pendingReasoning = '';
          messages.push({
            role: mappedRole,
            content: extractTextFromContent(item.content)
          });
        }
        break;
      }

      // ---- function_call (standalone, Codex 把模型 tool call 拆成独立 item) ----
      case 'function_call': {
        // 不立即创建消息，累积到缓冲区
        pendingToolCalls.push({
          id: item.call_id || callId(),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {})
          }
        });
        break;
      }

      // ---- function_call_output / tool_result ----
      case 'function_call_output':
      case 'tool_result': {
        // 先 flush 累积的 tool_calls（此时它们必须出现在 tool results 前面）
        flushPendingToolCalls();
        pendingReasoning = '';

        const callIdVal = item.call_id || '';
        messages.push({
          role: 'tool',
          tool_call_id: callIdVal,
          content: typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output || item.result || '')
        });
        break;
      }

      // ---- 自定义/未知工具结果 ----
      case 'custom_output':
      case 'tool_search_output':
      case 'web_search_call_output': {
        flushPendingToolCalls();
        pendingReasoning = '';
        const tcId = item.call_id || item.id || fallbackCallId();
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output || item.result || item.content || '')
        });
        console.log('[TRACE] mapped unknown-type output:', item.type, '→ tool, call_id=', tcId);
        break;
      }

      // ---- 自定义/未知工具调用 ----
      case 'custom':
      case 'tool_search':
      case 'web_search_call': {
        flushPendingToolCalls();
        pendingReasoning = '';
        const tcId = item.call_id || item.id || fallbackCallId();
        pendingToolCalls.push({
          id: tcId,
          type: 'function',
          function: {
            name: item.type || item.name || 'unknown_tool',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || item.input || {})
          }
        });
        // 立即 flush 单个调用
        flushPendingToolCalls();
        console.log('[TRACE] mapped unknown-type tool call:', item.type, '→ assistant tool_call');
        break;
      }

      // ---- 跳过 ----
      case 'item_reference':
      case 'item_reference_output':
        break;

      // ---- 兜底 ----
      default: {
        console.warn('[WARN] Unknown input item type:', item.type, '— trying best-effort mapping');
        flushPendingToolCalls();
        if (item.role) {
          pendingReasoning = '';
          messages.push({
            role: item.role === 'developer' ? 'system' : item.role,
            content: extractTextFromContent(item.content) || JSON.stringify(item)
          });
        } else if (item.output || item.content) {
          pendingReasoning = '';
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || item.id || fallbackCallId(),
            content: typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output || item.content || item)
          });
          console.log('[TRACE] best-effort unknown type', item.type, '→ tool message');
        }
        break;
      }
    }
  }

  // 循环结束时 flush 残余的 tool_calls
  flushPendingToolCalls();

  // 如果最后一条是纯 reasoning 的 assistant 没有内容也没有 tool_calls，移除
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && !last.tool_calls && (!last.content || last.content === '')) {
    // 只保留 reasoning_content 的情况：如果没内容，DeepSeek 也会拒绝
    if (!last.reasoning_content || last.reasoning_content === '') {
      messages.pop();
      console.log('[CLEANUP] removed empty trailing assistant');
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Streaming response handler
// ---------------------------------------------------------------------------

function handleStreamingResponse(res, dsRes, reqId, catalogModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  let buf = '';
  let reasoningText = '';
  let contentText = '';
  const toolCallsAccum = {};  // {index: {id, name, arguments, sseId}}
  let hasStarted = false;
  let hasSentContent = false;

  const oid = itemId();

  dsRes.on('data', function (chunk) {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || line === 'data: [DONE]') continue;
      if (line.indexOf('data: ') !== 0) continue;

      let parsed;
      try { parsed = JSON.parse(line.substring(6)); } catch (e) { continue; }

      const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
      if (!delta) continue;

      if (!hasStarted) {
        hasStarted = true;
        sse(res, 'response.created', {
          type: 'response.created',
          response: {
            id: reqId,
            object: 'response',
            status: 'in_progress',
            model: catalogModel || 'deepseek-v4-flash',
            output: []
          }
        });
      }

      // Reasoning content
      if (delta.reasoning_content) {
        reasoningText += delta.reasoning_content;
      }

      // Text content
      if (delta.content) {
        if (!hasSentContent) {
          hasSentContent = true;
          sse(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            response_id: reqId,
            output_index: 0,
            item: { id: oid, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
          });
          sse(res, 'response.content_part.added', {
            type: 'response.content_part.added',
            response_id: reqId,
            item_id: oid,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' }
          });
        }
        contentText += delta.content;
        sse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          response_id: reqId,
          item_id: oid,
          output_index: 0,
          content_index: 0,
          delta: delta.content
        });
      }

      // Tool calls from streaming
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          if (!toolCallsAccum[idx]) {
            toolCallsAccum[idx] = {
              id: tc.id || callId(),
              name: tc.function ? tc.function.name : '',
              arguments: '',
              sseId: itemId()
            };
            // 发送 output_item.added
            sse(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              response_id: reqId,
              output_index: parseInt(idx) + 1,
              item: {
                id: toolCallsAccum[idx].sseId,
                type: 'function_call',
                status: 'in_progress',
                name: toolCallsAccum[idx].name,
                call_id: toolCallsAccum[idx].id,
                arguments: ''
              }
            });
            sse(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              response_id: reqId,
              item_id: toolCallsAccum[idx].sseId,
              output_index: parseInt(idx) + 1,
              delta: ''
            });
          }
          if (tc.function && tc.function.arguments) {
            toolCallsAccum[idx].arguments += tc.function.arguments;
            sse(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              response_id: reqId,
              item_id: toolCallsAccum[idx].sseId,
              output_index: parseInt(idx) + 1,
              delta: tc.function.arguments
            });
          }
          // 更新 name（有时 name 在后续 chunk 才出现）
          if (tc.function && tc.function.name && !toolCallsAccum[idx].name) {
            toolCallsAccum[idx].name = tc.function.name;
          }
        }
      }
    }
  });

  dsRes.on('end', function () {
    // 1. Finalize text content
    if (hasSentContent) {
      sse(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        response_id: reqId,
        item_id: oid,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: contentText }
      });
      sse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: reqId,
        output_index: 0,
        item: {
          id: oid,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: contentText }]
        }
      });
    }

    // 2. Finalize tool calls
    const toolCallIdxs = Object.keys(toolCallsAccum);
    for (const idx of toolCallIdxs) {
      const tc = toolCallsAccum[idx];
      sse(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        response_id: reqId,
        item_id: tc.sseId,
        output_index: parseInt(idx) + 1,
        arguments: tc.arguments
      });
      sse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: reqId,
        output_index: parseInt(idx) + 1,
        item: {
          id: tc.sseId,
          type: 'function_call',
          status: 'completed',
          name: tc.name,
          call_id: tc.id,
          arguments: tc.arguments
        }
      });
    }

    // 3. Build output array
    const output = [];
    if (reasoningText) {
      output.push({
        id: 'rs_' + reqId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoningText }]
      });
    }
    if (hasSentContent) {
      const msgContent = contentText ? [{ type: 'output_text', text: contentText }] : [];
      output.push({ id: oid, type: 'message', role: 'assistant', content: msgContent });
    }
    for (const idx of toolCallIdxs) {
      const tc = toolCallsAccum[idx];
      output.push({
        id: tc.sseId,
        type: 'function_call',
        name: tc.name,
        call_id: tc.id,
        arguments: tc.arguments
      });
    }

    // 4. Send completed
    sse(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: reqId,
        object: 'response',
        status: 'completed',
        model: catalogModel || 'deepseek-v4-flash',
        output: output
      }
    });

    try { res.end(); } catch (e) {}
    console.log('[OK] streaming done, reasoning=%d text=%d tool_calls=%d',
      reasoningText.length, contentText.length, toolCallIdxs.length);
  });

  dsRes.on('error', function (e) {
    console.error('[STREAM_ERR]', e.message);
    sendSseErr(res, 'DeepSeek stream error: ' + e.message);
  });

  // Handle client disconnect
  res.on('close', function () {
    try { dsRes.destroy(); } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Non-streaming response handler
// ---------------------------------------------------------------------------

function handleNonStreamingResponse(res, dsRes, reqId, catalogModel) {
  let rb = '';
  dsRes.on('data', c => rb += c);
  dsRes.on('end', function () {
    try {
      const chatResp = JSON.parse(rb);
      if (!chatResp.choices || !chatResp.choices[0]) {
        sendJsonErr(res, 502, 'No choices in response');
        return;
      }
      const msg = chatResp.choices[0].message;
      const output = [];

      if (msg.reasoning_content) {
        output.push({
          id: 'rs_' + reqId,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: msg.reasoning_content }]
        });
      }

      if (msg.content) {
        output.push({
          id: reqId + '_msg',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }]
        });
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          output.push({
            id: itemId(),
            type: 'function_call',
            name: tc.function.name,
            call_id: tc.id,
            arguments: tc.function.arguments
          });
        }
      }

      const usage = chatResp.usage || {};
      const result = {
        id: reqId,
        object: 'response',
        status: 'completed',
        model: catalogModel || chatResp.model,
        output: output,
        usage: {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      console.log('[OK] non-stream tokens:', result.usage.total_tokens);
    } catch (e) {
      sendJsonErr(res, 502, 'Parse error: ' + e.message);
    }
  });
  dsRes.on('error', function (e) {
    console.error('[NONSTREAM_ERR]', e.message);
    // res may already be ended; safe-guard
    try { res.writeHead(502, { 'Content-Type': 'application/json' }); } catch (_) {}
    try { res.end(JSON.stringify({ error: { message: 'Upstream error: ' + e.message, type: 'proxy_error' } })); } catch (_) {}
  });
}

// ---------------------------------------------------------------------------
// Token estimation & auto-trim
// ---------------------------------------------------------------------------

// 匹配 CJK 字符：汉字 + 标点 + 全角符号 + 日韩文字
// 覆盖范围比之前扩大 ~30%，解决中文标点被当英文高估 token 的问题
const CJK_RE = /[⺀-⻿　-〿㇀-㇯㈀-㋿㌀-㏿㐀-䶿一-鿿豈-﫿︐-︟︰-﹏＀-￯ 0-⿿F　0-㿿F]/g;

// 保守估算消息 token 数
// 策略：不再区分 CJK/非CJK 的比例系数，直接使用一个偏保守的全局系数
// 经验值：代码+中英混合内容约 2.5 chars/token，保守取 2.2（高估 ≈10% 更安全）
function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    // 角色 token 开销
    total += 4;
    // 消息内容
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    total += Math.ceil(content.length / 2.2);
    // tool_calls 额外开销
    if (m.tool_calls) {
      const tcJson = JSON.stringify(m.tool_calls);
      total += Math.ceil(tcJson.length / 2.5);
    }
    // reasoning_content（中文推理居多）
    if (m.reasoning_content) {
      total += Math.ceil(m.reasoning_content.length / 2);
    }
  }
  return total;
}

// 自动裁剪消息列表，保留 system + 最近对话
// maxTokens: 目标上限（默认 650K，DeepSeek V4 限制 ~1M，留 35% 安全边界覆盖估算误差）
function autoTrim(messages, maxTokens) {
  maxTokens = maxTokens || 650000;
  const estimated = estimateTokens(messages);
  if (estimated <= maxTokens) return { messages, trimmed: 0, before: estimated, after: estimated };

  // 找到 system message 的位置
  let sysIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') { sysIdx = i; break; }
  }

  // 保留 system + 尾部消息，逐步裁剪头部
  const kept = sysIdx >= 0 ? [messages[sysIdx]] : [];
  const startIdx = sysIdx >= 0 ? sysIdx + 1 : 0;
  const tail = messages.slice(startIdx);

  // 从尾部反向求和，单趟 O(n) 找到保留起点
  let tailStart = 0;
  let runningTokens = estimateTokens(kept);
  // 从最后一条往前累加
  for (let i = tail.length - 1; i >= 0; i--) {
    runningTokens += estimateTokens([tail[i]]);
    if (runningTokens > maxTokens) {
      tailStart = i + 1; // 从下一条开始保留
      break;
    }
  }

  const trimmedCandidates = [...kept, ...tail.slice(tailStart)];

  // 确保不以孤儿 tool 消息开头——裁剪可能切掉了前面的 assistant(tool_calls)
  // DeepSeek 要求 tool 消息前必须有 assistant(tool_calls)
  let safeStart = 0;
  if (sysIdx >= 0) { safeStart = 1; } // 跳过 system
  for (let i = safeStart; i < trimmedCandidates.length; i++) {
    if (trimmedCandidates[i].role === 'tool') {
      safeStart = i + 1; // 跳过孤儿 tool
    } else {
      break;
    }
  }
  const trimmed = trimmedCandidates.slice(safeStart);
  if (safeStart > 0 && trimmed.length < trimmedCandidates.length) {
    console.log('[AUTO_TRIM] 移除开头 %d 条孤儿 tool 消息', trimmedCandidates.length - trimmed.length);
  }

  const afterTokens = estimateTokens(trimmed);
  const removed = messages.length - trimmed.length;

  if (removed > 0) {
    console.log('[AUTO_TRIM] 自动裁剪: %d 条消息, tokens %d → %d (移除了 %d 条历史消息)',
      messages.length, estimated, afterTokens, removed);
  }

  return { messages: trimmed, trimmed: removed, before: estimated, after: afterTokens };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB 上限，防止内存溢出

http.createServer(function (req, res) {
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    sendJsonErr(res, 404, 'Not Found. Use POST /v1/responses');
    return;
  }

  let body = '';
  let bodySize = 0;
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      sendJsonErr(res, 413, 'Request body too large');
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on('end', function () {
    if (bodySize > MAX_BODY_SIZE) return;
    let reqBody;
    try {
      reqBody = JSON.parse(body);
    } catch (e) {
      sendJsonErr(res, 400, 'Invalid JSON: ' + e.message);
      return;
    }

    const reqId = makeId();
    const isStream = reqBody.stream !== false;
    const maxTokens = reqBody.max_output_tokens || 8192;
    const model = reqBody.model || 'deepseek-v4-flash';
    let dsReq = null; // 闭包变量，供 req.on('close') 清理

    // 调试：打印 input 结构
    if (reqBody.input && Array.isArray(reqBody.input)) {
      const types = reqBody.input.map(it => it ? it.type : 'null').join(',');
      console.log('[DEBUG] input types:', types);
    }

    // Translate input
    const rawMessages = translateInput(reqBody.input);

    // 调试：打印消息结构
    console.log('[DEBUG] translated messages:', rawMessages.length,
      rawMessages.map(m => m.role + (m.tool_calls ? '(tc:' + m.tool_calls.length + ')' : '')).join(' → '));

    // 自动裁剪：超过 650K tokens 时透明裁剪历史消息
    const trimResult = autoTrim(rawMessages);
    const messages = trimResult.messages;

    // Build chat completion request
    const chatBody = {
      model: model,
      max_tokens: maxTokens,
      stream: isStream,
      messages: messages
    };

    // DeepSeek V4 reasoning: map Codex effort levels to V4-supported values
    if (reqBody.reasoning && reqBody.reasoning.effort) {
      const effort = reqBody.reasoning.effort;
      chatBody.reasoning_effort = (effort === 'xhigh') ? 'max' : 'high';
      chatBody.thinking = { type: 'enabled' };
    }

    // Forward tools (expand namespace tools into individual function tools)
    if (reqBody.tools && Array.isArray(reqBody.tools)) {
      const expanded = [];
      for (const t of reqBody.tools) {
        if (t.type === 'function' || t.type === 'tool') {
          expanded.push({
            type: 'function',
            function: t.function || { name: t.name, description: t.description, parameters: t.parameters }
          });
        } else if (t.type === 'namespace') {
          const subTools = t.functions || t.tools || [];
          if (Array.isArray(subTools)) {
            for (const fn of subTools) {
              const fnName = fn.name || '';
              const fnDesc = fn.description || t.description || '';
              const fnParams = fn.parameters || fn.input_schema || {};
              expanded.push({
                type: 'function',
                function: { name: fnName, description: fnDesc, parameters: fnParams }
              });
            }
          }
        } else if (t.type === 'web_search' || t.type === 'web_search_preview') {
          // web_search 不在 DeepSeek 支持范围，跳过（不报 WARN，正常情况）
        } else if (t.type === 'custom' || t.type === 'tool_search') {
          // Codex 专有工具，DeepSeek 不认识其 schema，跳过定义
          // 但结果在 translateInput 中会正确处理
          console.log('[INFO] Skipping tool definition for:', t.type,
            t.name || t.function?.name || '');
        } else {
          console.warn('[WARN] Unknown tool type in definition:', t.type, '— skipping');
        }
      }
      if (expanded.length > 0) chatBody.tools = expanded;
    }

    const postData = JSON.stringify(chatBody);
    const options = {
      hostname: HOST,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'Content-Length': Buffer.byteLength(postData, 'utf8')
      },
      timeout: 300000
    };

    console.log('[REQ] model=%s messages=%d tools=%s stream=%s',
      model, messages.length, chatBody.tools ? chatBody.tools.length : 0, isStream);

    dsReq = https.request(options, function (dsRes) {
      // 处理非 200 响应
      if (dsRes.statusCode !== 200) {
        let errBody = '';
        dsRes.on('data', c => errBody += c);
        dsRes.on('end', function () {
          const errMsg = 'DeepSeek HTTP ' + dsRes.statusCode + ': ' + errBody.slice(0, 500);
          console.error('[ERR]', errMsg);

          // 判断错误类型
          const isContextOverflow =
            errBody.includes('maximum context length') ||
            errBody.includes('context length') ||
            errBody.includes('reduce the length');

          // 上下文超限 → 返回 200 + 友好提示，Codex 看到正常完成不会重试
          if (isContextOverflow) {
            console.error('[CTX_OVERFLOW] 上下文超限，返回降级提示');
            const tipMsg = [
              '⚠️ **上下文长度超出 DeepSeek 限制**',
              '',
              '当前对话已超过模型支持的 1M token 上限。',
              '请执行 `/clear` 清空对话历史后重新提问，或用 `/compact` 压缩上下文。',
              '',
              '> 提示：`/compact` 会自动总结对话要点，保留关键信息同时大幅减少 token 占用。'
            ].join('\n');

            const rid = makeId();
            if (isStream) {
              // SSE 流模式：发送一个正常的消息告知用户
              const oid = itemId();
              sse(res, 'response.created', {
                type: 'response.created',
                response: { id: rid, object: 'response', status: 'in_progress', model: model || '', output: [] }
              });
              sse(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                response_id: rid, output_index: 0,
                item: { id: oid, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
              });
              sse(res, 'response.content_part.added', {
                type: 'response.content_part.added',
                response_id: rid, item_id: oid, output_index: 0, content_index: 0,
                part: { type: 'output_text', text: '' }
              });
              sse(res, 'response.output_text.delta', {
                type: 'response.output_text.delta',
                response_id: rid, item_id: oid, output_index: 0, content_index: 0, delta: tipMsg
              });
              sse(res, 'response.content_part.done', {
                type: 'response.content_part.done',
                response_id: rid, item_id: oid, output_index: 0, content_index: 0,
                part: { type: 'output_text', text: tipMsg }
              });
              sse(res, 'response.output_item.done', {
                type: 'response.output_item.done',
                response_id: rid, output_index: 0,
                item: { id: oid, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: tipMsg }] }
              });
              sse(res, 'response.completed', {
                type: 'response.completed',
                response: {
                  id: rid, object: 'response', status: 'completed', model: model || '',
                  output: [{ id: oid, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tipMsg }] }],
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
                }
              });
              try { res.end(); } catch (e) {}
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                id: rid, object: 'response', status: 'completed', model: model || '',
                output: [{ id: rid + '_msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tipMsg }] }],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
              }));
            }
            return;
          }

          // 其他错误：仍按原逻辑处理
          if (isStream) {
            sendSseErr(res, errMsg);
          } else {
            sendJsonErr(res, 502, errMsg);
          }
        });
        return;
      }

      if (isStream) {
        handleStreamingResponse(res, dsRes, reqId, model);
      } else {
        handleNonStreamingResponse(res, dsRes, reqId, model);
      }
    });

    dsReq.on('error', function (e) {
      console.error('[REQ_ERR]', e.message);
      if (isStream) {
        sendSseErr(res, 'Request error: ' + e.message);
      } else {
        sendJsonErr(res, 502, 'Request error: ' + e.message);
      }
    });

    dsReq.on('timeout', function () {
      dsReq.destroy();
      console.error('[TIMEOUT] DeepSeek request timed out');
      if (isStream) {
        sendSseErr(res, 'DeepSeek request timed out');
      } else {
        sendJsonErr(res, 504, 'DeepSeek request timed out');
      }
    });

    dsReq.write(postData);
    dsReq.end();

    // 客户端断开时销毁上游请求
    req.on('close', function () {
      if (dsReq) { try { dsReq.destroy(); } catch (e) {} }
    });
  });

  req.on('error', function (e) {
    console.error('[CLIENT_REQ_ERR]', e.message);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('[codex_proxy] Running on http://127.0.0.1:' + PORT + '/v1/responses');
  console.log('[codex_proxy] Translating Responses API -> DeepSeek Chat Completions API');
  console.log('[codex_proxy] Version: v5 (auto trim + overflow guard + robustness)');
});

// 全局异常处理：防止未捕获异常导致代理崩溃
process.on('uncaughtException', function (err) {
  console.error('[FATAL_UNCAUGHT]', err.message, err.stack);
});
process.on('unhandledRejection', function (reason) {
  console.error('[FATAL_REJECTION]', reason);
});

// 优雅退出
function shutdown(signal) {
  console.log('[SHUTDOWN] Received', signal, '— exiting');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
