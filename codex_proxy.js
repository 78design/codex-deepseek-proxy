#!/usr/bin/env node
/**
 * Codex CLI Responses API → DeepSeek Chat Completions API proxy
 *
 * Translates the OpenAI Responses API (used by Codex CLI v0.135.0)
 * to DeepSeek's /v1/chat/completions API, including tool call support.
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

function sendSseErr(res, msg) {
  // Send a proper SSE error event with "type" field so Codex can parse it
  sse(res, 'error', { type: 'error', error: { message: msg, type: 'proxy_error' } });
  // Send response.completed to unblock the client
  const rid = makeId();
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: { id: rid, object: 'response', status: 'failed', model: '', output: [] }
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
function extractReasoningText(item) {
  // reasoning item: { type: "reasoning", summary: [{ type: "summary_text", text: "..." }] }
  if (item.summary && Array.isArray(item.summary)) {
    return item.summary.map(s => s.text || '').join('');
  }
  return '';
}

function translateInput(input) {
  const messages = [];
  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: String(input) });
    return messages;
  }

  let pendingReasoning = ''; // reasoning_content to attach to next assistant message

  for (const item of input) {
    if (!item || !item.type) continue;

    switch (item.type) {
      case 'reasoning': {
        // DeepSeek requires reasoning_content to be passed back on subsequent requests
        pendingReasoning = extractReasoningText(item);
        break;
      }

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
              }
            }
          } else if (typeof item.content === 'string') {
            text = item.content;
          }

          const msg = toolCalls.length > 0
            ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
            : { role: 'assistant', content: text };

          // Attach pending reasoning_content if any
          if (pendingReasoning) {
            // DeepSeek requires the text content to match for reasoning messages
            msg.reasoning_content = pendingReasoning;
            pendingReasoning = '';
          }

          messages.push(msg);
        } else {
          // user or system — clear pending reasoning (it belongs to the prev assistant)
          pendingReasoning = '';
          messages.push({ role: mappedRole, content: extractTextFromContent(item.content) });
        }
        break;
      }

      case 'function_call_output':
      case 'tool_result': {
        pendingReasoning = '';
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '')
        });
        break;
      }

      case 'function_call': {
        pendingReasoning = '';
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || callId(),
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
            }
          }]
        });
        break;
      }

      default:
        console.warn('[WARN] Unknown input item type:', item.type);
        if (item.role) {
          pendingReasoning = '';
          messages.push({
            role: item.role === 'developer' ? 'system' : item.role,
            content: extractTextFromContent(item.content)
          });
        }
        break;
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
  const toolCallsAccum = {};  // {index: {id, name, arguments}}
  const outputItemIds = [];   // output_index -> item_id (for tool calls)

  const oid = itemId();
  let hasStarted = false;
  let hasSentContent = false;

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
          response: { id: reqId, object: 'response', status: 'in_progress', model: catalogModel || 'deepseek-v4-flash', output: [] }
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

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsAccum[idx]) {
            toolCallsAccum[idx] = {
              id: tc.id || callId(),
              name: tc.function ? tc.function.name : '',
              arguments: ''
            };
            const fcId = itemId();
            toolCallsAccum[idx].sseId = fcId;
            outputItemIds.push(fcId);

            sse(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              response_id: reqId,
              output_index: parseInt(idx) + 1,
              item: {
                id: fcId,
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
              item_id: fcId,
              output_index: parseInt(idx) + 1,
              delta: ''
            });
          }

          if (tc.function && tc.function.arguments) {
            toolCallsAccum[idx].arguments += tc.function.arguments;
            const fcId = toolCallsAccum[idx].sseId;
            sse(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              response_id: reqId,
              item_id: fcId,
              output_index: parseInt(idx) + 1,
              delta: tc.function.arguments
            });
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
      const fcId = tc.sseId;
      sse(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        response_id: reqId,
        item_id: fcId,
        output_index: parseInt(idx) + 1,
        part: {
          type: 'function_call',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      });
      sse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: reqId,
        output_index: parseInt(idx) + 1,
        item: {
          id: fcId,
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
    const model = reqBody.model || 'deepseek-v4-flash';  // Model names pass through directly (deepseek-v4-flash / deepseek-v4-pro)

    // Translate input
    const messages = translateInput(reqBody.input);

    // Build chat completion request
    const chatBody = {
      model: model,
      max_tokens: maxTokens,
      stream: isStream,
      messages: messages
    };

    // DeepSeek V4 reasoning: map Codex effort levels to V4-supported values
    // V4 only accepts "high" and "max"; low/medium map to high, xhigh maps to max
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
          // namespace is just metadata grouping; functions are listed separately
          // If it has named sub-tools, expand them
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
        } else if (t.type === 'web_search') {
          // web_search not supported by DeepSeek, silently skip
        } else {
          console.warn('[WARN] Unknown tool type:', t.type, '- dropping');
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
      if (dsRes.statusCode !== 200) {
        let errBody = '';
        dsRes.on('data', c => errBody += c);
        dsRes.on('end', function () {
          const errMsg = 'DeepSeek HTTP ' + dsRes.statusCode + ': ' + errBody.slice(0, 500);
          console.error('[ERR]', errMsg);
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
});
