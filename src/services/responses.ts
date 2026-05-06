/**
 * OpenAI Responses API compatibility layer.
 *
 * The Responses API (POST /v1/responses) is the *default* wire protocol for the
 * OpenAI Codex CLI (`wire_api = "responses"`). Without it, Codex falls back to
 * surfacing tool definitions as plain text and tool-calling silently breaks.
 *
 * This module:
 *   1. Translates a Responses API request → internal chat-format messages,
 *      flattening Responses-style tools[] and tool result items.
 *   2. Re-uses `streamChatCore` + `ToolCallStreamParser` to drive Cascade.
 *   3. Emits either the streaming Responses SSE event sequence or a single JSON
 *      response, both with proper `function_call` output items so Codex can
 *      execute the tool and feed the result back in the next turn.
 *
 * Spec reference (subset we implement):
 *   Input items:    message | function_call | function_call_output
 *   Tools:          { type:"function", name, description?, parameters?, strict? }
 *   Output items:   message (with output_text) | function_call | reasoning
 *   Stream events:  response.created, response.in_progress,
 *                   response.output_item.added, response.output_text.delta,
 *                   response.output_item.done, response.function_call_arguments.delta,
 *                   response.completed
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { log } from '../config.js';
import { resolveModel } from '../models.js';
import { streamChatCore, runChatCore, StreamContext, ChatError } from './chat.js';
import {
  buildToolPreamble,
  ToolCallStreamParser,
  ToolDef,
  parseToolCallsFromText,
} from './tool-emulation.js';
import { consumeQuota } from './token.js';
import { recordRequest } from './stats.js';
import { sanitizeText, PathSanitizeStream } from './sanitize.js';

// ─── Helpers ─────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, event: string, data: object) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getApiKey(req: http.IncomingMessage): string {
  const auth = req.headers['authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const xApiKey = req.headers['x-api-key'];
  return xApiKey ? String(xApiKey) : 'anonymous';
}

// ─── Request translation ─────────────────────────────────────

/**
 * Convert a Responses API request body to chat-format messages + tools.
 *
 * `input` can be:
 *   - string  → single user message
 *   - array of items where each item is:
 *       { type:"message", role, content: string | [{type:"input_text"|"output_text", text}, ...] }
 *       { type:"function_call", call_id, name, arguments }   (assistant prior tool call)
 *       { type:"function_call_output", call_id, output }     (tool result)
 *       { type:"reasoning", ... }                             (ignored — model regenerates)
 */
function translateRequest(body: any): { messages: any[]; tools: ToolDef[]; instructions: string } {
  const messages: any[] = [];
  const tools: ToolDef[] = [];

  // Normalize tools: Responses API uses flat {type,name,description,parameters},
  // chat format uses {type:"function", function:{name,description,parameters}}
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!t || t.type !== 'function' || !t.name) continue;
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
  }

  const instructions = typeof body.instructions === 'string' ? body.instructions : '';

  // Helper: extract text from a content array
  const extractText = (content: any): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') {
          return c.text || '';
        }
        // input_image, input_file etc. — represented as placeholder
        if (c?.type === 'input_image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  };

  // Process input
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    // Buffer assistant turns: text + tool_calls must be merged into ONE assistant message
    // because chat-format expects them together. Tool results become the next user msg.
    let pendingAssistant: { text: string; toolCalls: { id: string; name: string; args: string }[] } | null = null;

    const flushAssistant = () => {
      if (!pendingAssistant) return;
      const tcArr = pendingAssistant.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }));
      const msg: any = { role: 'assistant', content: pendingAssistant.text || '' };
      if (tcArr.length > 0) msg.tool_calls = tcArr;
      messages.push(msg);
      pendingAssistant = null;
    };

    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      const itemType = item.type || 'message';

      if (itemType === 'message') {
        flushAssistant();
        const role = item.role || 'user';
        const text = extractText(item.content);
        if (role === 'assistant') {
          pendingAssistant = { text, toolCalls: [] };
        } else if (text) {
          messages.push({ role, content: text });
        }
      } else if (itemType === 'function_call') {
        // Assistant emitted a tool call previously
        if (!pendingAssistant) pendingAssistant = { text: '', toolCalls: [] };
        const callId = item.call_id || item.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 16));
        const args = typeof item.arguments === 'string' ? item.arguments
          : (item.arguments != null ? JSON.stringify(item.arguments) : '{}');
        pendingAssistant.toolCalls.push({ id: callId, name: item.name || 'unknown', args });
      } else if (itemType === 'function_call_output') {
        flushAssistant();
        const content = typeof item.output === 'string' ? item.output
          : (item.output != null ? JSON.stringify(item.output) : '');
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content,
        });
      } else if (itemType === 'reasoning') {
        // Skip — model will regenerate reasoning
      } else {
        log.debug(`Responses: ignoring unknown input item type "${itemType}"`);
      }
    }
    flushAssistant();
  }

  // Prepend instructions as system message, if provided
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  // Inject tool preamble (same mechanism as chat.ts)
  if (tools.length > 0) {
    const preamble = buildToolPreamble(tools);
    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      messages[sysIdx] = { ...messages[sysIdx], content: preamble + (messages[sysIdx].content || '') };
    } else {
      messages.unshift({ role: 'system', content: preamble });
    }
  }

  // Final pass: convert tool_calls/tool messages to text form for Cascade
  // (same logic as services/tool-emulation.ts:convertToolMessages, inlined to
  // avoid double-wrapping the system preamble we just added).
  const flat: any[] = messages.map(msg => {
    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return {
        role: 'user',
        content: `<tool_result tool_call_id="${msg.tool_call_id || ''}">\n${content}\n</tool_result>`,
      };
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const parts: string[] = [];
      if (msg.content) parts.push(msg.content);
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        if (fn) {
          const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
          parts.push(`<tool_call>{"name": "${fn.name}", "arguments": ${args}}</tool_call>`);
        }
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    return msg;
  });

  return { messages: flat, tools, instructions };
}

// ─── Response building ───────────────────────────────────────

interface OutputItem {
  id: string;
  type: 'message' | 'function_call' | 'reasoning';
  // For type=message
  role?: 'assistant';
  content?: { type: 'output_text'; text: string; annotations: any[] }[];
  status?: 'in_progress' | 'completed';
  // For type=function_call
  call_id?: string;
  name?: string;
  arguments?: string;
  // For type=reasoning
  summary?: { type: 'summary_text'; text: string }[];
}

function buildOutputItems(opts: {
  text: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: string }[];
}): OutputItem[] {
  const items: OutputItem[] = [];

  if (opts.thinking) {
    items.push({
      id: 'rs_' + randomUUID().replace(/-/g, '').slice(0, 16),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: sanitizeText(opts.thinking) }],
    });
  }

  if (opts.text && opts.text.trim()) {
    items.push({
      id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 16),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: sanitizeText(opts.text), annotations: [] }],
    });
  }

  for (const tc of opts.toolCalls) {
    items.push({
      id: 'fc_' + randomUUID().replace(/-/g, '').slice(0, 16),
      type: 'function_call',
      call_id: tc.id,
      name: tc.name,
      arguments: tc.args,
      status: 'completed',
    });
  }

  return items;
}

// ─── Main handler ────────────────────────────────────────────

export async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
): Promise<void> {
  try {
    if (!body || (body.input == null && !body.messages)) {
      return json(res, 400, {
        error: { message: '"input" is required', type: 'invalid_request_error' },
      });
    }

    const modelKey = resolveModel(body.model);
    if (!modelKey) {
      return json(res, 404, {
        error: { message: `Model "${body.model}" not found`, type: 'invalid_request_error' },
      });
    }

    const authKey = getApiKey(req);
    const stream = !!body.stream;
    const responseId = 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
    const createdAt = Math.floor(Date.now() / 1000);

    const { messages, tools } = translateRequest(body);
    const hasTools = tools.length > 0;

    log.debug(`Responses: model=${modelKey}, stream=${stream}, tools=${tools.length}, msgs=${messages.length}`);

    // Reasoning/thinking budget: Responses API uses { reasoning: { effort: "low|medium|high" } }
    const effort = body.reasoning?.effort;
    const thinkingBudget =
      effort === 'low' ? 8000 :
      effort === 'medium' ? 32000 :
      effort === 'high' ? 128000 :
      body.thinking_budget || 64000;

    if (stream) {
      await handleStreaming(res, body, messages, modelKey, authKey, hasTools, thinkingBudget, responseId, createdAt);
    } else {
      await handleNonStreaming(res, body, messages, modelKey, authKey, hasTools, thinkingBudget, responseId, createdAt);
    }
  } catch (err: any) {
    if (err instanceof ChatError) {
      if (!res.headersSent) {
        json(res, err.statusCode, { error: { message: err.message, type: 'api_error' } });
      }
    } else {
      log.error('Responses API error:', err.message);
      if (!res.headersSent) {
        json(res, 500, { error: { message: err.message, type: 'api_error' } });
      }
    }
    if (res.headersSent && !res.writableEnded) res.end();
  }
}

async function handleNonStreaming(
  res: http.ServerResponse,
  body: any,
  messages: any[],
  modelKey: string,
  authKey: string,
  hasTools: boolean,
  _thinkingBudget: number,
  responseId: string,
  createdAt: number,
): Promise<void> {
  const result = await runChatCore(messages, modelKey, authKey);

  // Parse tool calls out of the accumulated text (only when caller provided tools[])
  let finalText = result.text;
  const toolCalls: { id: string; name: string; args: string }[] = [];
  if (hasTools) {
    const parsed = parseToolCallsFromText(result.text);
    finalText = parsed.text;
    for (const tc of parsed.toolCalls) {
      toolCalls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments });
    }
  }

  const output = buildOutputItems({ text: finalText, thinking: result.thinking, toolCalls });
  const status = toolCalls.length > 0 ? 'completed' : 'completed';

  json(res, 200, {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: result.modelInfo.name,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools || [],
    usage: {
      input_tokens: result.promptTokens,
      output_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
    },
  });
}

async function handleStreaming(
  res: http.ServerResponse,
  body: any,
  messages: any[],
  modelKey: string,
  authKey: string,
  hasTools: boolean,
  thinkingBudget: number,
  responseId: string,
  createdAt: number,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let sequenceNumber = 0;
  const next = () => sequenceNumber++;
  const baseResponse = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    model: body.model,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools || [],
  };

  // 1. response.created
  sse(res, 'response.created', {
    type: 'response.created',
    sequence_number: next(),
    response: { ...baseResponse, status: 'in_progress', output: [] },
  });
  // 2. response.in_progress
  sse(res, 'response.in_progress', {
    type: 'response.in_progress',
    sequence_number: next(),
    response: { ...baseResponse, status: 'in_progress', output: [] },
  });

  let outputIndex = 0;
  let messageItemId: string | null = null;
  let messageContentIndexAdded = false;
  let accumulatedText = '';
  let accumulatedThinking = '';
  const completedItems: OutputItem[] = [];
  let ctx!: StreamContext;
  const textSanitizer = new PathSanitizeStream();
  const toolParser = hasTools ? new ToolCallStreamParser() : null;

  const ensureMessageItem = () => {
    if (messageItemId) return;
    messageItemId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 16);
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: outputIndex,
      item: {
        id: messageItemId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
  };

  const ensureContentPart = () => {
    if (messageContentIndexAdded) return;
    sse(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: next(),
      item_id: messageItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    messageContentIndexAdded = true;
  };

  const closeMessageItem = () => {
    if (!messageItemId) return;
    if (messageContentIndexAdded) {
      sse(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        sequence_number: next(),
        item_id: messageItemId,
        output_index: outputIndex,
        content_index: 0,
        text: sanitizeText(accumulatedText),
      });
      sse(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        sequence_number: next(),
        item_id: messageItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: sanitizeText(accumulatedText), annotations: [] },
      });
    }
    const item: OutputItem = {
      id: messageItemId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: sanitizeText(accumulatedText), annotations: [] }],
    };
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: next(),
      output_index: outputIndex,
      item,
    });
    completedItems.push(item);
    outputIndex++;
    messageItemId = null;
    messageContentIndexAdded = false;
    accumulatedText = '';
  };

  const emitFunctionCall = (callId: string, name: string, args: string) => {
    closeMessageItem();
    const fcId = 'fc_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const startItem: OutputItem = {
      id: fcId,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '',
      status: 'in_progress',
    };
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: outputIndex,
      item: startItem,
    });
    if (args) {
      sse(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        sequence_number: next(),
        item_id: fcId,
        output_index: outputIndex,
        delta: args,
      });
    }
    sse(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      sequence_number: next(),
      item_id: fcId,
      output_index: outputIndex,
      arguments: args,
    });
    const doneItem: OutputItem = { ...startItem, arguments: args, status: 'completed' };
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: next(),
      output_index: outputIndex,
      item: doneItem,
    });
    completedItems.push(doneItem);
    outputIndex++;
  };

  try {
    for await (const chunk of streamChatCore(messages, modelKey, authKey, { thinkingBudget })) {
      ctx = chunk.ctx;

      // Reasoning: emit as a reasoning item once at the end (Codex doesn't need
      // streaming reasoning, but we keep accumulated copy for completeness).
      if (chunk.thinking) accumulatedThinking += chunk.thinking;

      if (chunk.text) {
        const safeText = textSanitizer.feed(chunk.text);
        if (!safeText) continue;
        if (toolParser) {
          const parsed = toolParser.feed(safeText);
          if (parsed.text) {
            ensureMessageItem();
            ensureContentPart();
            accumulatedText += parsed.text;
            sse(res, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              sequence_number: next(),
              item_id: messageItemId,
              output_index: outputIndex,
              content_index: 0,
              delta: parsed.text,
            });
          }
          for (const tc of parsed.toolCalls) {
            emitFunctionCall(tc.id, tc.function.name, tc.function.arguments);
          }
        } else {
          ensureMessageItem();
          ensureContentPart();
          accumulatedText += safeText;
          sse(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            sequence_number: next(),
            item_id: messageItemId,
            output_index: outputIndex,
            content_index: 0,
            delta: safeText,
          });
        }
      }
    }

    // Flush
    const flushed = textSanitizer.flush();
    if (flushed) {
      if (toolParser) {
        const parsed = toolParser.feed(flushed);
        if (parsed.text) {
          ensureMessageItem();
          ensureContentPart();
          accumulatedText += parsed.text;
          sse(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            sequence_number: next(),
            item_id: messageItemId,
            output_index: outputIndex,
            content_index: 0,
            delta: parsed.text,
          });
        }
        for (const tc of parsed.toolCalls) {
          emitFunctionCall(tc.id, tc.function.name, tc.function.arguments);
        }
      } else {
        ensureMessageItem();
        ensureContentPart();
        accumulatedText += flushed;
        sse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          sequence_number: next(),
          item_id: messageItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: flushed,
        });
      }
    }
    if (toolParser) {
      const finalParsed = toolParser.flush();
      if (finalParsed.text) {
        ensureMessageItem();
        ensureContentPart();
        accumulatedText += finalParsed.text;
        sse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          sequence_number: next(),
          item_id: messageItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: finalParsed.text,
        });
      }
      for (const tc of finalParsed.toolCalls) {
        emitFunctionCall(tc.id, tc.function.name, tc.function.arguments);
      }
    }
    closeMessageItem();
  } catch (err: any) {
    log.error('Responses streaming error:', err?.message);
    sse(res, 'response.failed', {
      type: 'response.failed',
      sequence_number: next(),
      response: {
        ...baseResponse,
        status: 'failed',
        error: { code: 'server_error', message: err?.message || 'unknown' },
      },
    });
    res.end();
    return;
  }

  // response.completed
  const inputTokens = ctx?.serverInputTokens || ctx?.promptTokens || 0;
  const outputTokens = ctx?.serverOutputTokens || Math.ceil(
    completedItems.reduce((s, it) => s + (it.content?.[0]?.text?.length || it.arguments?.length || 0), 0) / 4,
  );
  sse(res, 'response.completed', {
    type: 'response.completed',
    sequence_number: next(),
    response: {
      ...baseResponse,
      status: 'completed',
      output: completedItems,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        ...(ctx?.cacheReadTokens ? { input_tokens_details: { cached_tokens: ctx.cacheReadTokens } } : {}),
      },
    },
  });
  res.end();

  if (ctx) {
    const tokensUsed = inputTokens + outputTokens;
    consumeQuota(ctx.authKey, tokensUsed);
    recordRequest({ model: ctx.modelKey, channelId: ctx.channel.id, tokensUsed });
  }
}
