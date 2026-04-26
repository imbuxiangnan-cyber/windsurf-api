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
 * Claude Code sends tools in the `tools` parameter; when we replace its system
 * prompt, we need to re-inject tool awareness with authoritative instructions.
 *
 * Based on dwgx/WindsurfAPI's proven format with numbered rules.
 */
function buildAnthropicToolPreamble(tools: any[]): string {
  if (!tools || tools.length === 0) return '';

  const lines: string[] = [
    'You have access to the following functions. To invoke a function, emit a block in this EXACT format:',
    '',
    '<tool_call>{"name":"<function_name>","arguments":{...}}</tool_call>',
    '',
    'Rules:',
    '1. Each <tool_call>...</tool_call> block must fit on ONE line (no line breaks inside the JSON).',
    '2. "arguments" must be a JSON object matching the function\'s parameter schema.',
    '3. You MAY emit MULTIPLE <tool_call> blocks if the request requires calling several functions. Emit ALL needed calls consecutively, then STOP generating.',
    '4. After emitting the last <tool_call> block, STOP. Do not write any explanation after it. The caller executes the functions and returns results in the next turn.',
    '5. NEVER say "I don\'t have access to tools" or "I cannot perform that action" — the functions listed below ARE your available tools.',
    '6. When a function is relevant to the user\'s request, you SHOULD call it rather than answering from memory.',
    '7. ONLY use function names from the list below. Do NOT use: read_file, view_file, create_file, edit_file, run_command, command, search_replace, file_search, code_search, update_plan, grep_search, list_directory, ViewFile, RunCommand. These names DO NOT EXIST.',
    '8. The "name" field in your <tool_call> MUST exactly match one of the function names listed below.',
    '9. The Bash tool runs in a Linux/Unix shell (not Windows CMD). Use Unix commands: cat (not type), ls (not dir), cp/mv/rm (not copy/move/del). For Windows paths, use forward slashes: /c/Users/... or /mnt/c/Users/...',
    '10. Do NOT repeatedly call the same tool with the same arguments. If a tool result was already returned, use it directly.',
    '',
    'Available functions:',
  ];

  // For Claude Code with 30+ tools, use ultra-compact format to save context space.
  // Well-known tools: just name. Custom/unusual tools: name + short description.
  const WELL_KNOWN = new Set([
    'Read', 'Edit', 'MultiEdit', 'Write', 'Bash', 'Grep', 'Glob', 'Search',
    'ListDir', 'Agent', 'TodoRead', 'TodoWrite', 'WebSearch', 'WebFetch',
    'NotebookRead', 'NotebookEdit',
  ]);
  const useCompact = tools.length > 15;

  if (useCompact) {
    const known: string[] = [];
    const custom: string[] = [];
    for (const tool of tools) {
      if (!tool.name) continue;
      if (WELL_KNOWN.has(tool.name)) {
        known.push(tool.name);
      } else {
        // Short description: truncate to 80 chars
        const desc = tool.description ? `: ${tool.description.slice(0, 80)}` : '';
        custom.push(`- ${tool.name}${desc}`);
      }
    }
    if (known.length > 0) {
      lines.push(`Standard tools: ${known.join(', ')}`);
    }
    if (custom.length > 0) {
      lines.push('Additional tools:');
      lines.push(...custom);
    }
  } else {
    for (const tool of tools) {
      if (!tool.name) continue;
      lines.push('');
      lines.push(`### ${tool.name}`);
      if (tool.description) lines.push(tool.description);
      if (tool.input_schema) {
        lines.push('Parameters:');
        lines.push('```json');
        lines.push(JSON.stringify(tool.input_schema, null, 2));
        lines.push('```');
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Warn threshold for very large conversations */
const LARGE_CONVERSATION_CHARS = 100_000;

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
      const toolNames = body.tools.map((t: any) => t.name).filter(Boolean);
      log.info(`Injected tool preamble for ${body.tools.length} Anthropic tools: [${toolNames.slice(0, 8).join(', ')}${toolNames.length > 8 ? ', ...' : ''}]`);
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
          messages.push({ role: msg.role, content: msg.content });
          continue;
        }

        // Separate text, tool_calls, and tool_results
        const textParts: string[] = [];
        const toolCallParts: string[] = [];
        const toolResults: { id: string; content: string }[] = [];

        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'thinking') {
            // Skip — model regenerates thinking
          } else if (block.type === 'tool_use') {
            // Convert to <tool_call> format (matching our parser/preamble)
            const input = block.input ?? {};
            toolCallParts.push(`<tool_call>${JSON.stringify({ name: block.name, arguments: input })}</tool_call>`);
          } else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content) ? block.content.map((b: any) => b.text || '').join('\n') : '';
            toolResults.push({ id: block.tool_use_id || '', content: resultContent });
          }
        }

        // Assistant messages with tool_calls
        if (msg.role === 'assistant' && toolCallParts.length > 0) {
          const parts = [...textParts, ...toolCallParts];
          messages.push({ role: 'assistant', content: parts.join('\n') });
        } else if (textParts.length > 0) {
          messages.push({ role: msg.role, content: textParts.join('\n') });
        }

        // Tool results → separate user messages with <tool_result> wrapper
        for (const tr of toolResults) {
          messages.push({
            role: 'user',
            content: `<tool_result tool_call_id="${tr.id}">\n${tr.content}\n</tool_result>`,
          });
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
    // Warn about very large conversations but pass through fully
    const totalChars = messages.reduce((s, m) => s + String(m.content).length, 0);
    if (totalChars > LARGE_CONVERSATION_CHARS) {
      log.warn(`Large conversation: ${messages.length} msgs, ${totalChars} chars — Cascade LS may timeout`);
    }
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

      // Build valid tool name set + Cascade→Claude Code name mapping
      const validToolNames = new Set<string>();
      if (hasTools) {
        for (const t of body.tools) if (t.name) validToolNames.add(t.name);
      }
      // Map ALL known IDE/Cascade/variant tool names to likely Claude Code equivalents.
      // The model tries dozens of wrong names — we map them all.
      const CASCADE_TO_CLAUDE: Record<string, string[]> = {
        // Reading files
        read_file: ['Read', 'read_file', 'ReadFiles', 'read'],
        view_file: ['Read', 'read_file', 'ReadFiles', 'read'],
        ReadFile: ['Read', 'read_file', 'ReadFiles', 'read'],
        read_file_content: ['Read', 'read_file', 'ReadFiles', 'read'],
        view_code_item: ['Read', 'read_file', 'ReadFiles', 'read'],
        cat: ['Read', 'read_file', 'ReadFiles', 'read'],
        // Writing/creating files
        create_file: ['Write', 'write_to_file', 'CreateFile', 'write'],
        write_file: ['Write', 'write_to_file', 'CreateFile', 'write'],
        WriteFile: ['Write', 'write_to_file', 'CreateFile', 'write'],
        // Editing files
        edit_file: ['Edit', 'MultiEdit', 'edit_file', 'edit'],
        search_replace: ['Edit', 'MultiEdit', 'SearchReplace', 'edit'],
        EditFile: ['Edit', 'MultiEdit', 'edit_file', 'edit'],
        // Running commands
        run_command: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        command: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        shell: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        execute_command: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        RunCommand: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        exec: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        terminal: ['Bash', 'execute_command', 'RunCommand', 'bash'],
        // Searching
        grep_search: ['Grep', 'grep_search', 'Search', 'search', 'grep'],
        file_search: ['Search', 'find_by_name', 'ListDir', 'search', 'Glob'],
        code_search: ['Search', 'code_search', 'Grep', 'search', 'grep'],
        search_files: ['Search', 'find_by_name', 'Grep', 'search', 'grep'],
        search_code: ['Search', 'code_search', 'Grep', 'search', 'grep'],
        SearchFiles: ['Search', 'find_by_name', 'Grep', 'search'],
        CodeSearch: ['Search', 'code_search', 'Grep', 'search'],
        find_by_name: ['Search', 'find_by_name', 'Glob', 'search'],
        // Listing
        list_dir: ['ListDir', 'list_dir', 'ListDirectory', 'list_directory', 'ls'],
        list_directory: ['ListDir', 'list_dir', 'ListDirectory', 'list_directory', 'ls'],
        ListDirectory: ['ListDir', 'list_dir', 'ListDirectory', 'list_directory', 'ls'],
        // Planning/todos
        update_plan: ['TodoWrite', 'todo_write', 'UpdatePlan', 'todowrite'],
        // Web
        web_search: ['WebSearch', 'web_search', 'search_web'],
      };
      // Remap Cascade argument names to Claude Code equivalents
      function fixToolArgs(fixedName: string, originalName: string, input: any): any {
        if (fixedName === originalName || typeof input !== 'object' || !input) return input;
        const mapped = { ...input };
        // read_file/view_file/ViewFile/ReadFile → Read: target_file → file_path
        const readLike = ['read_file', 'view_file', 'ViewFile', 'ReadFile', 'read_file_content', 'view_code_item', 'cat'];
        if (readLike.includes(originalName)) {
          if (mapped.target_file && !mapped.file_path) {
            mapped.file_path = mapped.target_file;
            delete mapped.target_file;
          }
          if (mapped.should_read_entire_file !== undefined) {
            delete mapped.should_read_entire_file;
          }
        }
        // run_command/command/shell/RunCommand/exec → Bash: working_directory → cd prefix
        const bashLike = ['run_command', 'command', 'shell', 'RunCommand', 'execute_command', 'exec', 'terminal'];
        if (bashLike.includes(originalName)) {
          if (mapped.working_directory) {
            // Bash doesn't have working_directory — prepend cd
            if (mapped.command && !mapped.command.startsWith('cd ')) {
              mapped.command = `cd ${mapped.working_directory} && ${mapped.command}`;
            }
            delete mapped.working_directory;
          }
        }
        return mapped;
      }
      function fixToolName(name: string): string {
        if (validToolNames.has(name)) return name;
        // 1. Exact lookup in mapping table
        const candidates = CASCADE_TO_CLAUDE[name] || CASCADE_TO_CLAUDE[name.toLowerCase()];
        if (candidates) {
          for (const c of candidates) {
            if (validToolNames.has(c)) {
              log.warn(`Mapped Cascade tool "${name}" → "${c}"`);
              return c;
            }
          }
        }
        // 2. Case-insensitive exact match
        for (const v of validToolNames) {
          if (v.toLowerCase() === name.toLowerCase()) {
            log.warn(`Mapped tool "${name}" → "${v}" (case fix)`);
            return v;
          }
        }
        // 3. Normalize: strip underscores/hyphens, compare lowercase
        const normalized = name.toLowerCase().replace(/[-_]/g, '');
        for (const v of validToolNames) {
          if (v.toLowerCase().replace(/[-_]/g, '') === normalized) {
            log.warn(`Mapped tool "${name}" → "${v}" (normalized)`);
            return v;
          }
        }
        // 4. Semantic category match: find the first valid tool that belongs
        //    to the same category (read→Read, write→Write, bash→Bash, etc.)
        const CATEGORY_KEYWORDS: Record<string, string[]> = {
          read: ['read', 'view', 'cat', 'get', 'show', 'display', 'open'],
          write: ['write', 'create', 'new', 'make', 'save'],
          edit: ['edit', 'modify', 'update', 'replace', 'change', 'patch', 'search_replace'],
          bash: ['run', 'command', 'exec', 'shell', 'terminal', 'bash', 'cmd'],
          search: ['search', 'find', 'grep', 'locate', 'query', 'lookup'],
          list: ['list', 'ls', 'dir', 'directory', 'tree'],
          todo: ['todo', 'plan', 'task'],
          web: ['web', 'url', 'http', 'fetch', 'browse'],
        };
        const nameLower = name.toLowerCase().replace(/[-_]/g, '');
        for (const [_category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
          if (keywords.some(kw => nameLower.includes(kw))) {
            // Check mapping table for any matching category keyword
            for (const kw of keywords) {
              for (const [mapKey, mapCandidates] of Object.entries(CASCADE_TO_CLAUDE)) {
                if (mapKey.toLowerCase().includes(kw)) {
                  for (const c of mapCandidates) {
                    if (validToolNames.has(c)) {
                      log.warn(`Mapped tool "${name}" → "${c}" (category: ${kw})`);
                      return c;
                    }
                  }
                }
              }
            }
          }
        }
        log.warn(`Unknown tool name "${name}" — not in client's ${validToolNames.size} tools`);
        return name;
      }

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
            const safeText = textSanitizer.feed(chunk.text);
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
                const fixedName = fixToolName(tc.function.name);
                const fixedInput = fixToolArgs(fixedName, tc.function.name, input);
                emitToolUseBlock(toolId, fixedName, fixedInput);
                emittedToolUse = true;
                log.info(`Parsed tool_call → tool_use: ${tc.function.name}${fixedName !== tc.function.name ? ' → ' + fixedName : ''} (${toolId})`);
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
          const fixedName = fixToolName(tc.function.name);
          const fixedInput = fixToolArgs(fixedName, tc.function.name, input);
          emitToolUseBlock(toolId, fixedName, fixedInput);
          emittedToolUse = true;
          log.info(`Parsed tool_call → tool_use (flush): ${tc.function.name}${fixedName !== tc.function.name ? ' → ' + fixedName : ''}`);
        }
      } else if (toolParser) {
        const finalParsed = toolParser.flush();
        if (finalParsed.text) flushText = finalParsed.text;
        for (const tc of finalParsed.toolCalls) {
          const toolId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16);
          let input: any;
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { raw: tc.function.arguments }; }
          const fixedName2 = fixToolName(tc.function.name);
          const fixedInput2 = fixToolArgs(fixedName2, tc.function.name, input);
          emitToolUseBlock(toolId, fixedName2, fixedInput2);
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

      // Diagnostic: log output summary for debugging tool call issues
      const stopReason = emittedToolUse ? 'tool_use' : 'end_turn';
      log.info(`Anthropic response: stop=${stopReason}, textLen=${fullText.length}, thinkingLen=${fullThinking.length}, toolUse=${emittedToolUse}`);
      if (fullText.length > 0 && fullText.length < 500) {
        log.debug(`Response text: ${fullText.replace(/\n/g, '\\n').slice(0, 300)}`);
      }

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
