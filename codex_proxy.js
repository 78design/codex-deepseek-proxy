#!/usr/bin/env node
/**
 * Codex CLI Responses API → DeepSeek Chat Completions API proxy
 *
 * Translates the OpenAI Responses API (used by Codex CLI v0.135.0)
 * to DeepSeek's /v1/chat/completions API, including tool call support.
 *
 * Fixed v2:
 *   - reasoning_content 严格绑定到紧随的 assistant 消息
 *   - function_call_output 的 call_id 空值回退
 *   - 未知工具类型不再简单丢弃，尝试提取有用信息
 *   - 400 错误时优雅降级而非无限重试
 *   - 更详细的调试日志
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

function translateInput(input) {
  const messages = [];
  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: String(input) });
    return messages;
  }

  let pendingReasoning = ''; // reasoning_content 等待附加到下一个 assistant

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || !item.type) {
      console.warn('[WARN] input item missing type at index', i, '— skipping');
      continue;
    }

    switch (item.type) {

      // ---- reasoning ----
      case 'reasoning': {
        // 累积 reasoning 文本，附加到紧随的下一个 assistant 消息
        pendingReasoning = (pendingReasoning || '') + extractReasoningText(item);
        break;
      }

      // ---- message (user / assistant / developer) ----
      case 'message': {
        const role = item.role || 'user';
        const mappedRole = role === 'developer' ? 'system' : role;

        if (mappedRole === 'assistant') {
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
                // 有些实现把 reasoning 嵌在 assistant content 里
                pendingReasoning = (pendingReasoning || '') + (c.text || '');
              }
            }
          } else if (typeof item.content === 'string') {
            text = item.content;
          }

          const msg = toolCalls.length > 0
            ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
            : { role: 'assistant', content: text || '' };

          // 将 pendingReasoning 附加到当前 assistant
          if (pendingReasoning) {
            msg.reasoning_content = pendingReasoning;
            pendingReasoning = '';
          }

          messages.push(msg);
        } else {
          // user 或 system — 清空 pending reasoning
          pendingReasoning = '';
          messages.push({
            role: mappedRole,
            content: extractTextFromContent(item.content)
          });
        }
        break;
      }

      // ---- function_call_output / tool_result ----
      case 'function_call_output':
      case 'tool_result': {
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

      // ---- function_call (standalone, from output -> next input) ----
      case 'function_call': {
        pendingReasoning = '';
        const fcCallId = item.call_id || callId();
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: fcCallId,
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {})
            }
          }]
        });
        break;
      }

      // ---- 自定义/未知工具的结果 ----
      // Codex 特有类型（custom / tool_search / web_search_call 等）：
      //   工具定义在转发时被丢弃了，但 Codex 可能返回其执行结果。
      //   把这些结果映射为 tool 消息，用 item.id 做 call_id。
      case 'custom_output':
      case 'tool_search_output':
      case 'web_search_call_output': {
        pendingReasoning = '';
        const tcId = item.call_id || item.id || fallbackCallId();
        const outContent = typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output || item.result || item.content || '');
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: outContent
        });
        console.log('[TRACE] mapped unknown-type output:', item.type, '→ tool, call_id=', tcId);
        break;
      }

      // ---- 自定义/未知工具调用 ----
      case 'custom':
      case 'tool_search':
      case 'web_search_call': {
        pendingReasoning = '';
        const tcId = item.call_id || item.id || fallbackCallId();
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: tcId,
            type: 'function',
            function: {
              name: item.type || 'unknown_tool',
              arguments: JSON.stringify(item.arguments || item.input || {})
            }
          }]
        });
        console.log('[TRACE] mapped unknown-type tool call:', item.type, '→ assistant tool_call');
        break;
      }

      // ---- item_reference / item_reference_output — 跳过 ----
      case 'item_reference':
      case 'item_reference_output':
        // 这些是 Codex 内部引用，跳过
        break;

      // ---- 兜底 ----
      default: {
        console.warn('[WARN] Unknown input item type:', item.type, '— trying best-effort mapping');
        // 尝试从 item 中提取可用的角色和内容
        if (item.role) {
          pendingReasoning = '';
          messages.push({
            role: item.role === 'developer' ? 'system' : item.role,
            content: extractTextFromContent(item.content) || JSON.stringify(item)
          });
        } else if (item.output || item.content) {
          // 如果一个未知类型有 output/content，可能是工具结果
          pendingReasoning = '';
          const fallbackTcId = item.call_id || item.id || fallbackCallId();
          messages.push({
            role: 'tool',
            tool_call_id: fallbackTcId,
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

  // 最后再遍历一遍，确保每个 assistant 的 tool_calls 数量与实际 tool 消息匹配
  // 如果检测到不匹配，尝试修复
  return validateAndFixMessages(messages);
}

// ---------------------------------------------------------------------------
// 验证并修复消息链：确保 tool_calls 与后续 tool 消息匹配
// ---------------------------------------------------------------------------
function validateAndFixMessages(messages) {
  const fixed = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      fixed.push(msg);
      const expectedCount = msg.tool_calls.length;
      let actualCount = 0;

      // 收集后续 tool 消息
      const toolMsgs = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        toolMsgs.push(messages[j]);
        actualCount++;
        j++;
      }

      if (actualCount < expectedCount) {
        console.warn('[FIXUP] assistant has', expectedCount, 'tool_calls but only', actualCount, 'tool messages follow — injecting missing');
        // 不注入假消息（会破坏工具调用链），只记录警告
        // DeepSeek 应该拒绝这个请求，错误会被上层处理
      }

      // 推入 tool 消息
      for (const tm of toolMsgs) {
        fixed.push(tm);
      }
      i += actualCount;
    } else {
      fixed.push(msg);
    }
  }

  // 检查最后的 assistant 是否有未匹配的 tool_calls
  const lastIdx = fixed.length - 1;
  if (lastIdx >= 0 && fixed[lastIdx].role === 'assistant' && fixed[lastIdx].tool_calls && fixed[lastIdx].tool_calls.length > 0) {
    console.warn('[FIXUP] Last message is assistant with', fixed[lastIdx].tool_calls.length, 'tool_calls but no tool results — removing trailing tool_calls');
    // 如果这是最后一条消息，移除 tool_calls（可能是 Codex 还没执行工具就重试了）
    delete fixed[lastIdx].tool_calls;
    if (fixed[lastIdx].content === null) {
      fixed[lastIdx].content = ''; // 防止 null content
    }
  }

  return fixed;
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
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

http.createServer(function (req, res) {
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    sendJsonErr(res, 404, 'Not Found. Use POST /v1/responses');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', function () {
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

    // 调试：打印 input 结构
    if (reqBody.input && Array.isArray(reqBody.input)) {
      const types = reqBody.input.map(it => it ? it.type : 'null').join(',');
      console.log('[DEBUG] input types:', types);
    }

    // Translate input
    const messages = translateInput(reqBody.input);

    // 调试：打印消息结构
    console.log('[DEBUG] translated messages:', messages.length,
      messages.map(m => m.role + (m.tool_calls ? '(tc:' + m.tool_calls.length + ')' : '')).join(' → '));

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
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 300000
    };

    console.log('[REQ] model=%s messages=%d tools=%s stream=%s',
      model, messages.length, chatBody.tools ? chatBody.tools.length : 0, isStream);

    const dsReq = https.request(options, function (dsRes) {
      // 处理非 200 响应
      if (dsRes.statusCode !== 200) {
        let errBody = '';
        dsRes.on('data', c => errBody += c);
        dsRes.on('end', function () {
          const errMsg = 'DeepSeek HTTP ' + dsRes.statusCode + ': ' + errBody.slice(0, 500);
          console.error('[ERR]', errMsg);

          // 判断是否是不可恢复的错误
          const isUnrecoverable =
            errBody.includes('insufficient tool messages') ||
            errBody.includes('reasoning_content') ||
            errBody.includes('tool_calls');

          if (isUnrecoverable) {
            // 不可恢复：告诉 Codex 本轮失败，需要清空上下文重新开始
            console.error('[FATAL] Unrecoverable error detected — sending failed response to Codex');
          }

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
  });

  req.on('error', function (e) {
    console.error('[CLIENT_REQ_ERR]', e.message);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('[codex_proxy] Running on http://127.0.0.1:' + PORT + '/v1/responses');
  console.log('[codex_proxy] Translating Responses API -> DeepSeek Chat Completions API');
  console.log('[codex_proxy] Version: v2 (with input validation & fixup)');
});
