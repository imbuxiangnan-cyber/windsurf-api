/**
 * Anthropic Messages API compatibility layer.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { log } from '../config.js';
import { resolveModel, isThinkingModel } from '../models.js';
import { runChatCore, streamChatCore, StreamContext, StreamChunk, ChatError } from './chat.js';
import { ToolCallStreamParser } from './tool-emulation.js';
import { consumeQuota } from './token.js';
import { recordRequest } from './stats.js';
import { stripMessagesPayload } from './strip-reminders.js';
import { PathSanitizeStream, sanitizeText } from './sanitize.js';

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sse(res: http.ServerResponse, data: object) {
  res.write(`event: ${(data as any).type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getApiKey(req: http.IncomingMessage): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) return String(xApiKey);
  const auth = req.headers['authorization'] || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * Build a tool preamble from Anthropic-format tools[].
 * Claude Code sends tools in the `tools` parameter; when we strip its system
 * prompt (to avoid content policy), we need to re-inject tool awareness.
 */
function buildAnthropicToolPreamble(tools: any[]): string {
  if (!tools || tools.length === 0) return '';
  const lines: string[] = [
    'You have access to the following tools. To call a tool, output a JSON block wrapped in <tool_call> tags.',
    'Format: <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>',
    'You may call multiple tools by outputting multiple <tool_call> blocks.',
    'After the tool results are provided, continue your response.',
    '',
    'Available tools:',
  ];
  for (const tool of tools) {
    if (!tool.name) continue;
    lines.push(`- ${tool.name}: ${tool.description || '(no description)'}`);
    if (tool.input_schema) {
      lines.push(`  Input schema: ${JSON.stringify(tool.input_schema)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Strip echoed tool XML from text output (model sometimes echoes history) */
const ECHOED_TOOL_XML = /<\/?(?:tool_result|tool_use|tool_call)[^>]*>[\s\S]*?(?:<\/(?:tool_result|tool_use|tool_call)>|$)/g;
const ECHOED_TOOL_TAGS = /<\/?(?:tool_result|tool_use)[^>]*>/g;

function stripEchoedToolXml(text: string): string {
  // First try to strip complete blocks
  let cleaned = text.replace(ECHOED_TOOL_XML, '');
  // Then strip any remaining orphan tags
  cleaned = cleaned.replace(ECHOED_TOOL_TAGS, '');
  // Clean up excess whitespace from removal
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function convertMessages(body: any): any[] {
  const messages: any[] = [];
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const systemText = body.system
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      if (systemText) messages.push({ role: 'system', content: systemText });
    }
  }

  // Inject tool preamble when tools[] present
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const preamble = buildAnthropicToolPreamble(body.tools);
    if (preamble) {
      // Append to existing system message or create new one
      if (messages.length > 0 && messages[0].role === 'system') {
        messages[0].content += '\n\n' + preamble;
      } else {
        messages.unshift({ role: 'system', content: preamble });
      }
      log.info(`Injected tool preamble for ${body.tools.length} Anthropic tools`);
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        if (msg.content) messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Check if content has image blocks — if so, preserve array for multimodal extraction
        const hasImages = msg.content.some((b: any) => b.type === 'image');
        if (hasImages) {
          // Preserve content array for image extraction in client.ts
          messages.push({ role: msg.role, content: msg.content });
        } else {
          // Text-only: extract and serialize
          const parts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              parts.push(block.text);
            } else if (block.type === 'thinking' && block.thinking) {
              parts.push(`<thinking>\n${block.thinking}\n</thinking>`);
            } else if (block.type === 'tool_use') {
              parts.push(`<tool_use id="${block.id}" name="${block.name}">\n${JSON.stringify(block.input)}\n</tool_use>`);
            } else if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map((b: any) => b.text || '').join('\n') : '';
              parts.push(`<tool_result tool_use_id="${block.tool_use_id}">\n${resultContent}\n</tool_result>`);
            }
          }
          const content = parts.join('\n');
          if (content) messages.push({ role: msg.role, content });
        }
      }
    }
  }
  return messages;
}

export async function handleAnthropicMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
): Promise<void> {
  try {
    const authKey = getApiKey(req);
    if (!authKey) {
      return json(res, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Missing x-api-key or Authorization header' },
      });
    }

    // Strip Claude Code boilerplate system prompt + <system-reminder> blocks
    // These trigger Windsurf's content policy filter
    const strippedBody = stripMessagesPayload(body);
    if (strippedBody.system !== body.system) {
      const sysLen = typeof strippedBody.system === 'string' ? strippedBody.system.length
        : Array.isArray(strippedBody.system) ? strippedBody.system.reduce((s: number, b: any) => s + (b.text?.length || 0), 0) : 0;
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      log.info(`Replaced system prompt (${sysLen} chars)${toolCount ? ` + ${toolCount} tools from body.tools` : ''}`);
    }

    const modelKey = resolveModel(strippedBody.model);
    if (!modelKey) {
      return json(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: `Model "${strippedBody.model}" not found` },
      });
    }

    const messages = convertMessages(strippedBody);
    const stream = !!body.stream;
    const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);

    // Thinking budget: maximize for thinking-capable models.
    // For dedicated thinking models → always use max (128000)
    // For other Claude models → use client's budget or default 128000
    const maxBudget = modelKey.includes('opus') ? 128000 : 64000;
    const clientBudget = body.thinking?.budget_tokens;
    const thinkingBudget = isThinkingModel(modelKey)
      ? maxBudget  // Force maximum for thinking models
      : (clientBudget || maxBudget);
    log.debug(`Thinking: model=${modelKey}, budget=${thinkingBudget} (client requested: ${clientBudget ?? 'none'})`);

    if (stream) {
      let headersSent = false;
      let sentStart = false;
      let fullText = '';
      let fullThinking = '';
      let ctx!: StreamContext;
      const textSanitizer = new PathSanitizeStream();
      const thinkingSanitizer = new PathSanitizeStream();
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const toolParser = hasTools ? new ToolCallStreamParser() : null;
      let emittedToolUse = false;

      // Block state tracking
      let blockIndex = 0;
      let currentBlockType: 'thinking' | 'text' | null = null;

      function closeCurrentBlock() {
        if (currentBlockType === null) return;
        sse(res, { type: 'content_block_stop', index: blockIndex });
        currentBlockType = null;
        blockIndex++;
      }

      function ensureBlock(type: 'thinking' | 'text') {
        if (currentBlockType === type) return;
        closeCurrentBlock();
        if (type === 'thinking') {
          sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
        } else {
          sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        }
        currentBlockType = type;
      }

      function emitToolUseBlock(id: string, name: string, input: any) {
        closeCurrentBlock();
        sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id, name, input: {} } });
        const inputJson = typeof input === 'string' ? input : JSON.stringify(input);
        sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: inputJson } });
        sse(res, { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }

      // Heartbeat: send ping events to keep downstream alive
      const HEARTBEAT_MS = 30_000;
      let lastDataAt = Date.now();
      const heartbeatTimer = setInterval(() => {
        if (!headersSent || res.writableEnded) { clearInterval(heartbeatTimer); return; }
        const silenceMs = Date.now() - lastDataAt;
        if (silenceMs >= 300_000) {
          // Upstream silent for 5 min — send error and close
          log.warn(`Anthropic SSE: upstream silent for ${Math.round(silenceMs / 1000)}s, closing`);
          try {
            sse(res, { type: 'error', error: { type: 'api_error', message: 'Upstream timeout — no data received.' } });
          } catch { /* client gone */ }
          clearInterval(heartbeatTimer);
          try { res.end(); } catch { /* ignore */ }
          return;
        }
        try { sse(res, { type: 'ping' }); } catch { /* client disconnected */ }
      }, HEARTBEAT_MS);

      try {
        for await (const chunk of streamChatCore(messages, modelKey, authKey, { thinkingBudget })) {
          lastDataAt = Date.now();
          if (!headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            });
            headersSent = true;
          }
          ctx = chunk.ctx;

          if (!sentStart) {
            sse(res, {
              type: 'message_start',
              message: {
                id: msgId, type: 'message', role: 'assistant',
                model: body.model, content: [],
                stop_reason: null, stop_sequence: null,
                usage: { input_tokens: ctx.promptTokens, output_tokens: 0 },
              },
            });
            sentStart = true;
          }

          // Thinking deltas → thinking block (sanitized)
          if (chunk.thinking) {
            const safeThinking = thinkingSanitizer.feed(chunk.thinking);
            if (safeThinking) {
              fullThinking += safeThinking;
              ensureBlock('thinking');
              sse(res, {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'thinking_delta', thinking: safeThinking },
              });
            }
          }

          // Tool calls → tool_use content blocks
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            for (const tc of chunk.toolCalls) {
              let input: any;
              try { input = JSON.parse(tc.argumentsJson || '{}'); } catch { input = { raw: tc.argumentsJson }; }
              const toolId = tc.id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 16));
              emitToolUseBlock(toolId, tc.name, input);
              log.debug(`Emitted tool_use: ${tc.name} (${toolId})`);
            }
          }

          // Run commands → tool_use block (command execution)
          if (chunk.runCommand) {
            const cmd = chunk.runCommand;
            const cmdLine = cmd.proposedCommandLine || cmd.commandLine || '';
            if (cmdLine) {
              const toolId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16);
              emitToolUseBlock(toolId, 'bash', { command: cmdLine, cwd: cmd.cwd || undefined });
              log.debug(`Emitted bash tool_use: ${cmdLine.slice(0, 60)}`);

              // If command has output, emit as text
              const output = cmd.combinedOutput || cmd.stdout || cmd.stderr || '';
              if (output) {
                const exitInfo = cmd.exitCode !== null ? ` (exit ${cmd.exitCode})` : '';
                const outputText = sanitizeText(`\n\`\`\`\n${output.trim()}\n\`\`\`${exitInfo}\n`);
                fullText += outputText;
                ensureBlock('text');
                sse(res, {
                  type: 'content_block_delta', index: blockIndex,
                  delta: { type: 'text_delta', text: outputText },
                });
              }
            }
          }

          // Text deltas → text block (sanitized, auto-closes thinking block first)
          // When tools are present, parse <tool_call> blocks from text
          if (chunk.text) {
            let safeText = textSanitizer.feed(chunk.text);
            // Strip echoed tool XML from text (model sometimes echoes history)
            if (safeText && ECHOED_TOOL_TAGS.test(safeText)) {
              ECHOED_TOOL_TAGS.lastIndex = 0;
              safeText = safeText.replace(ECHOED_TOOL_TAGS, '').replace(/\n{3,}/g, '\n\n');
            }
            if (safeText && toolParser) {
              const parsed = toolParser.feed(safeText);
              if (parsed.text) {
                fullText += parsed.text;
                ensureBlock('text');
                sse(res, {
                  type: 'content_block_delta', index: blockIndex,
                  delta: { type: 'text_delta', text: parsed.text },
                });
              }
              for (const tc of parsed.toolCalls) {
                const toolId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16);
                let input: any;
                try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { raw: tc.function.arguments }; }
                emitToolUseBlock(toolId, tc.function.name, input);
                emittedToolUse = true;
                log.debug(`Parsed tool_call → tool_use: ${tc.function.name} (${toolId})`);
              }
            } else if (safeText) {
              fullText += safeText;
              ensureBlock('text');
              sse(res, {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text: safeText },
              });
            }
          }
        }
      } finally {
        clearInterval(heartbeatTimer);
      }

      // Flush sanitizer buffers
      const flushThinking = thinkingSanitizer.flush();
      if (flushThinking) {
        fullThinking += flushThinking;
        ensureBlock('thinking');
        sse(res, {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'thinking_delta', thinking: flushThinking },
        });
      }
      let flushText = textSanitizer.flush();
      if (flushText && toolParser) {
        const parsed = toolParser.flush();
        flushText = parsed.text;
        for (const tc of parsed.toolCalls) {
          const toolId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16);
          let input: any;
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { raw: tc.function.arguments }; }
          emitToolUseBlock(toolId, tc.function.name, input);
          emittedToolUse = true;
          log.debug(`Parsed tool_call → tool_use (flush): ${tc.function.name}`);
        }
      } else if (toolParser) {
        const finalParsed = toolParser.flush();
        if (finalParsed.text) flushText = finalParsed.text;
        for (const tc of finalParsed.toolCalls) {
          const toolId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16);
          let input: any;
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { raw: tc.function.arguments }; }
          emitToolUseBlock(toolId, tc.function.name, input);
          emittedToolUse = true;
        }
      }
      if (flushText) {
        fullText += flushText;
        ensureBlock('text');
        sse(res, {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: flushText },
        });
      }

      // Close any open block
      closeCurrentBlock();

      // If nothing was output, emit an empty text block
      if (blockIndex === 0) {
        sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse(res, { type: 'content_block_stop', index: 0 });
      }

      // Prefer server-reported token counts, fall back to estimates
      const inputTokens = ctx?.serverInputTokens || ctx?.promptTokens || 0;
      const outputTokens = ctx?.serverOutputTokens || Math.ceil(fullText.length / 4);
      const cacheRead = ctx?.cacheReadTokens || 0;
      const cacheWrite = ctx?.cacheWriteTokens || 0;
      sse(res, {
        type: 'message_delta',
        delta: { stop_reason: emittedToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheWrite,
          cache_read_input_tokens: cacheRead,
        },
      });
      sse(res, { type: 'message_stop' });
      res.end();

      if (ctx) {
        const tokensUsed = inputTokens + outputTokens;
        consumeQuota(ctx.authKey, tokensUsed);
        recordRequest({ model: ctx.modelKey, channelId: ctx.channel.id, tokensUsed });
      }
    } else {
      const result = await runChatCore(messages, modelKey, authKey);
      const content: any[] = [];
      if (result.thinking) {
        content.push({ type: 'thinking', thinking: sanitizeText(result.thinking) });
      }
      content.push({ type: 'text', text: sanitizeText(result.text) });

      json(res, 200, {
        id: msgId, type: 'message', role: 'assistant',
        model: body.model, content,
        stop_reason: 'end_turn', stop_sequence: null,
        usage: {
          input_tokens: result.promptTokens,
          output_tokens: result.completionTokens,
        },
      });
    }
  } catch (err: any) {
    if (err instanceof ChatError) {
      if (!res.headersSent) {
        json(res, err.statusCode, {
          type: 'error',
          error: {
            type: err.statusCode === 401 ? 'authentication_error' :
                  err.statusCode === 429 ? 'rate_limit_error' : 'api_error',
            message: err.message,
          },
        });
      }
    } else {
      log.error('Anthropic API error:', err.message);
      if (!res.headersSent) {
        json(res, 500, {
          type: 'error',
          error: { type: 'api_error', message: err.message },
        });
      }
    }
    if (res.headersSent && !res.writableEnded) res.end();
  }
}
