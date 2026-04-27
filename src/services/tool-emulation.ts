/**
 * Tool Emulation for Cascade.
 *
 * Cascade's protocol has no per-request slot for client-defined function
 * schemas. To expose tool-calling to clients, we:
 *   1. Serialize `tools[]` into a text preamble injected into the system prompt,
 *      instructing the model to use `<tool_call>` blocks.
 *   2. Parse `<tool_call>` blocks (and bare JSON variants) from the streaming
 *      response and convert them to OpenAI-compatible tool_call objects.
 *   3. Serialize tool_result messages back into text for the next turn.
 *   4. Strip `<tool_result>` blocks the model echoes from conversation history.
 *
 * Based on dwgx/WindsurfAPI's proven design. Compatible with:
 * OpenAI Chat Completions, Anthropic Messages, Cursor, Aider, Continue.dev, Claude Code
 */

import { log } from '../config.js';

// ─── Preamble builder ────────────────────────────────────────

export interface ToolDef {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
}

/**
 * Build a text preamble that describes available tools to the model.
 * This gets prepended to the system prompt when tools[] is present.
 */
export function buildToolPreamble(tools: ToolDef[]): string {
  if (!tools || tools.length === 0) return '';

  const lines: string[] = [
    'You have access to the following tools. To call a tool, output a JSON block wrapped in <tool_call> tags on a SINGLE line.',
    'Format: <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>',
    'You may call multiple tools by outputting multiple <tool_call> lines.',
    'After the tool results are provided, continue your response.',
    '',
    'Available tools:',
  ];

  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.name) continue;
    lines.push(`- ${fn.name}: ${fn.description || '(no description)'}`);
    if (fn.parameters) {
      lines.push(`  Parameters: ${JSON.stringify(fn.parameters)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Message converter ───────────────────────────────────────

/**
 * Convert tool_result messages back to plain text for Cascade.
 * In OpenAI protocol, tool results come as { role: 'tool', tool_call_id, content }.
 * We serialize them into `<tool_result>` blocks.
 */
export function convertToolMessages(messages: any[]): any[] {
  return messages.map(msg => {
    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return {
        role: 'user',
        content: `<tool_result tool_call_id="${msg.tool_call_id || ''}">\n${content}\n</tool_result>`,
      };
    }
    // Assistant messages with tool_calls — convert to text with <tool_call> blocks
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
}

// ─── JSON helpers ────────────────────────────────────────────

/** Lenient JSON parser — handles trailing braces and stray whitespace */
function safeParseJson(s: string): any {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  // Scan from first { or [ and find balanced block
  const t = s.trim();
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ─── XML tool call parser ────────────────────────────────────

/**
 * Parse XML-format tool calls inside <tool_call> blocks.
 * Model sometimes outputs:
 *   <tool_call><tool_name>NAME</tool_name><parameters><param>value</param>...</parameters></tool_call>
 * instead of the JSON format we specified.
 */
function parseXmlToolCall(body: string): { name: string; arguments: Record<string, any> } | null {
  // Extract tool name from <tool_name>...</tool_name>
  const nameMatch = body.match(/<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;

  // Extract parameters from <parameters>...</parameters>
  const paramsMatch = body.match(/<parameters>\s*([\s\S]*?)\s*<\/parameters>/);
  if (!paramsMatch) return { name, arguments: {} };

  const paramsContent = paramsMatch[1].trim();
  const args: Record<string, any> = {};

  // Try to parse as JSON first (sometimes params are JSON inside XML wrapper)
  const jsonArgs = safeParseJson(paramsContent);
  if (jsonArgs && typeof jsonArgs === 'object') return { name, arguments: jsonArgs };

  // Parse individual XML param tags: <param_name>value</param_name>
  const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = paramRegex.exec(paramsContent)) !== null) {
    const [, paramName, paramValue] = match;
    // Try to parse value as JSON (for objects/arrays/numbers)
    const jsonVal = safeParseJson(paramValue);
    if (jsonVal !== null) {
      args[paramName] = jsonVal;
    } else {
      args[paramName] = paramValue.trim();
    }
  }

  return { name, arguments: args };
}

// ─── Streaming parser ────────────────────────────────────────

export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

const TC_OPEN = '<tool_call>';
const TC_CLOSE = '</tool_call>';
const TR_PREFIX = '<tool_result';
const TR_CLOSE = '</tool_result>';
const BARE_JSON = '{"name"';
// Matches 'tool:ToolName' (start of line or preceded by newline)
const TOOL_COLON_RE = /(?:^|\n)(tool:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n)/;
const PREFIXES = [TC_OPEN, TR_PREFIX, BARE_JSON, 'tool:'];
const MAX_BLOCK_SIZE = 65_536;

/**
 * Incremental streaming parser for tool-call blocks in text deltas.
 *
 * Handles three formats:
 *   1. <tool_call>{"name":"...","arguments":{...}}</tool_call>  (primary)
 *   2. {"name":"...","arguments":{...}}                          (bare JSON)
 *   3. <tool_result ...>...</tool_result>                        (stripped/discarded)
 *   4. tool:Name\n{"arg":"val"}\n</tool:Name>                  (colon format)
 *
 * Based on dwgx/WindsurfAPI's battle-tested ToolCallStreamParser.
 */
export class ToolCallStreamParser {
  private buffer = '';
  private inToolCall = false;
  private inToolResult = false;
  private inBareCall = false;
  private inColonCall = false;
  private colonToolName = '';
  private callCounter = 0;

  feed(delta: string): { text: string; toolCalls: ParsedToolCall[] } {
    if (!delta) return { text: '', toolCalls: [] };
    this.buffer += delta;
    return this._parse();
  }

  flush(): { text: string; toolCalls: ParsedToolCall[] } {
    const remaining = this.buffer;
    this.buffer = '';

    if (this.inToolCall) {
      this.inToolCall = false;
      return { text: `<tool_call>${remaining}`, toolCalls: [] };
    }
    if (this.inToolResult) {
      this.inToolResult = false;
      return { text: '', toolCalls: [] };
    }
    if (this.inBareCall) {
      this.inBareCall = false;
      const tc = this._parseBareJson(remaining);
      if (tc) return { text: '', toolCalls: [tc] };
      return { text: remaining, toolCalls: [] };
    }
    if (this.inColonCall) {
      this.inColonCall = false;
      const tc = this._parseColonBody(this.colonToolName, remaining);
      if (tc) return { text: '', toolCalls: [tc] };
      return { text: remaining, toolCalls: [] };
    }
    return { text: remaining, toolCalls: [] };
  }

  private _parse(): { text: string; toolCalls: ParsedToolCall[] } {
    const safeParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // ── Inside <tool_result>: discard until close ──
      if (this.inToolResult) {
        const closeIdx = this.buffer.indexOf(TR_CLOSE);
        if (closeIdx === -1) break;
        this.buffer = this.buffer.slice(closeIdx + TR_CLOSE.length);
        this.inToolResult = false;
        continue;
      }

      // ── Inside <tool_call>: parse JSON body ──
      if (this.inToolCall) {
        if (this.buffer.length > MAX_BLOCK_SIZE) {
          log.warn(`ToolParser: <tool_call> block exceeds 65KB, emitting as text`);
          safeParts.push(this.buffer);
          this.buffer = '';
          this.inToolCall = false;
          break;
        }
        const closeIdx = this.buffer.indexOf(TC_CLOSE);
        if (closeIdx === -1) break;
        const body = this.buffer.slice(0, closeIdx).trim();
        this.buffer = this.buffer.slice(closeIdx + TC_CLOSE.length);
        this.inToolCall = false;

        const parsed = safeParseJson(body);
        if (parsed && typeof parsed.name === 'string') {
          const args = parsed.arguments;
          const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          this.callCounter++;
          toolCalls.push({
            id: `call_${this.callCounter}_${Date.now().toString(36)}`,
            type: 'function',
            function: { name: parsed.name, arguments: argsJson },
          });
          log.debug(`ToolParser: matched <tool_call> JSON format, name=${parsed.name}`);
        } else {
          // Try XML format: <tool_name>NAME</tool_name><parameters>...</parameters>
          const xmlTc = parseXmlToolCall(body);
          if (xmlTc) {
            this.callCounter++;
            toolCalls.push({
              id: `call_${this.callCounter}_${Date.now().toString(36)}`,
              type: 'function',
              function: { name: xmlTc.name, arguments: JSON.stringify(xmlTc.arguments) },
            });
            log.debug(`ToolParser: matched <tool_call> XML format, name=${xmlTc.name}`);
          } else {
            safeParts.push(`<tool_call>${body}</tool_call>`);
          }
        }
        continue;
      }

      // ── Inside tool:Name ... </tool:Name> ──
      if (this.inColonCall) {
        if (this.buffer.length > MAX_BLOCK_SIZE) {
          log.warn(`ToolParser: tool:${this.colonToolName} block exceeds 65KB, emitting as text`);
          safeParts.push(this.buffer);
          this.buffer = '';
          this.inColonCall = false;
          break;
        }
        const closeTag = `</tool:${this.colonToolName}>`;
        const closeIdx = this.buffer.indexOf(closeTag);
        if (closeIdx === -1) break;
        const body = this.buffer.slice(0, closeIdx).trim();
        this.buffer = this.buffer.slice(closeIdx + closeTag.length);
        this.inColonCall = false;
        const tc = this._parseColonBody(this.colonToolName, body);
        if (tc) {
          toolCalls.push(tc);
        } else {
          safeParts.push(body);
        }
        continue;
      }

      // ── Inside bare JSON {"name":"...","arguments":{...}} ──
      if (this.inBareCall) {
        if (this.buffer.length > MAX_BLOCK_SIZE) {
          log.warn(`ToolParser: bare JSON block exceeds 65KB, emitting as text`);
          safeParts.push(this.buffer);
          this.buffer = '';
          this.inBareCall = false;
          break;
        }
        const endIdx = this._findClosingBrace();
        if (endIdx === -1) break;
        const jsonStr = this.buffer.slice(0, endIdx + 1);
        this.buffer = this.buffer.slice(endIdx + 1);
        this.inBareCall = false;
        const tc = this._parseBareJson(jsonStr);
        if (tc) {
          toolCalls.push(tc);
        } else {
          safeParts.push(jsonStr);
        }
        continue;
      }

      // ── Normal mode: scan for next opening tag ──
      const tcIdx = this.buffer.indexOf(TC_OPEN);
      const trIdx = this.buffer.indexOf(TR_PREFIX);
      const bareIdx = this.buffer.indexOf(BARE_JSON);
      // Check for tool:Name format
      const colonMatch = TOOL_COLON_RE.exec(this.buffer);

      // Find earliest match
      const candidates: { idx: number; type: string }[] = [];
      if (tcIdx !== -1) candidates.push({ idx: tcIdx, type: 'tc' });
      if (trIdx !== -1) candidates.push({ idx: trIdx, type: 'tr' });
      if (bareIdx !== -1) candidates.push({ idx: bareIdx, type: 'bare' });
      if (colonMatch) candidates.push({ idx: colonMatch.index + (colonMatch[0].startsWith('\n') ? 1 : 0), type: 'colon' });
      candidates.sort((a, b) => a.idx - b.idx);

      if (candidates.length === 0) {
        // No tags found — emit safe text, hold partial prefixes
        const holdLen = this._partialPrefixLength();
        const emitUpto = this.buffer.length - holdLen;
        if (emitUpto > 0) safeParts.push(this.buffer.slice(0, emitUpto));
        this.buffer = this.buffer.slice(emitUpto);
        break;
      }

      const first = candidates[0];

      // Emit text before the tag
      if (first.idx > 0) safeParts.push(this.buffer.slice(0, first.idx));

      if (first.type === 'tc') {
        this.buffer = this.buffer.slice(first.idx + TC_OPEN.length);
        this.inToolCall = true;
      } else if (first.type === 'tr') {
        // Find closing > of the opening tag
        const closeAngle = this.buffer.indexOf('>', first.idx + TR_PREFIX.length);
        if (closeAngle === -1) {
          this.buffer = this.buffer.slice(first.idx);
          break;
        }
        this.buffer = this.buffer.slice(closeAngle + 1);
        this.inToolResult = true;
      } else if (first.type === 'bare') {
        this.buffer = this.buffer.slice(first.idx);
        this.inBareCall = true;
      } else if (first.type === 'colon' && colonMatch) {
        const fullOpen = colonMatch[1]; // 'tool:Name\n'
        const toolName = colonMatch[2]; // 'Name'
        this.buffer = this.buffer.slice(first.idx + fullOpen.length);
        this.inColonCall = true;
        this.colonToolName = toolName;
        log.debug(`ToolParser: entering tool:${toolName} colon format`);
      }
    }

    return { text: safeParts.join(''), toolCalls };
  }

  /** Find the closing brace for a balanced JSON object at buffer start */
  private _findClosingBrace(): number {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** Parse tool:Name body — the JSON is the arguments directly (not wrapped in {name, arguments}) */
  private _parseColonBody(toolName: string, body: string): ParsedToolCall | null {
    const parsed = safeParseJson(body);
    if (!parsed || typeof parsed !== 'object') return null;
    const argsJson = JSON.stringify(parsed);
    this.callCounter++;
    log.info(`ToolParser: matched tool:${toolName} colon format`);
    return {
      id: `call_${this.callCounter}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: toolName, arguments: argsJson },
    };
  }

  /** Parse a bare JSON string into a tool call */
  private _parseBareJson(jsonStr: string): ParsedToolCall | null {
    const parsed = safeParseJson(jsonStr);
    if (!parsed || typeof parsed.name !== 'string' || !('arguments' in parsed)) return null;
    const args = parsed.arguments;
    const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    this.callCounter++;
    log.debug(`ToolParser: matched bare JSON format, name=${parsed.name}`);
    return {
      id: `call_${this.callCounter}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: parsed.name, arguments: argsJson },
    };
  }

  /** Check if buffer tail matches a partial prefix of any known tag */
  private _partialPrefixLength(): number {
    let maxHold = 0;
    for (const prefix of PREFIXES) {
      const maxLen = Math.min(prefix.length - 1, this.buffer.length);
      for (let len = maxLen; len > 0; len--) {
        if (this.buffer.endsWith(prefix.slice(0, len))) {
          maxHold = Math.max(maxHold, len);
          break;
        }
      }
    }
    return maxHold;
  }
}

/**
 * Run a complete (non-streamed) text through the parser in one shot.
 */
export function parseToolCallsFromText(text: string): { text: string; toolCalls: ParsedToolCall[] } {
  const parser = new ToolCallStreamParser();
  const a = parser.feed(text);
  const b = parser.flush();
  return {
    text: a.text + b.text,
    toolCalls: [...a.toolCalls, ...b.toolCalls],
  };
}
