/**
 * Tool Emulation for Cascade.
 *
 * Cascade doesn't natively support OpenAI's function/tool calling protocol.
 * This module emulates it by:
 *   1. Serializing `tools[]` from the request into a text preamble injected
 *      into the system prompt, instructing the model to use `<tool_call>` blocks.
 *   2. Parsing `<tool_call>` blocks from the streaming response and converting
 *      them to OpenAI-compatible tool_call objects.
 *   3. Serializing tool_result messages back into text for the next turn.
 *
 * Compatible with: OpenAI Chat Completions, Cursor, Aider, Continue.dev
 */

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

// ─── Streaming parser ────────────────────────────────────────

export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Incremental streaming parser for <tool_call> blocks in text deltas.
 *
 * Usage:
 *   const parser = new ToolCallStreamParser();
 *   for (const delta of textDeltas) {
 *     const result = parser.feed(delta);
 *     if (result.text) emit(result.text);
 *     if (result.toolCalls.length) emitToolCalls(result.toolCalls);
 *   }
 *   const final = parser.flush();
 *   if (final.text) emit(final.text);
 */
export class ToolCallStreamParser {
  private buffer = '';
  private callCounter = 0;

  feed(delta: string): { text: string; toolCalls: ParsedToolCall[] } {
    this.buffer += delta;
    return this._extract();
  }

  flush(): { text: string; toolCalls: ParsedToolCall[] } {
    const result = this._extract();
    // Anything remaining in buffer is plain text
    if (this.buffer) {
      result.text += this.buffer;
      this.buffer = '';
    }
    return result;
  }

  private _extract(): { text: string; toolCalls: ParsedToolCall[] } {
    let text = '';
    const toolCalls: ParsedToolCall[] = [];

    while (true) {
      const openIdx = this.buffer.indexOf('<tool_call>');
      if (openIdx === -1) {
        // No open tag — check if buffer ends with partial tag
        const partialIdx = this._partialTagIndex();
        if (partialIdx >= 0) {
          text += this.buffer.slice(0, partialIdx);
          this.buffer = this.buffer.slice(partialIdx);
        } else {
          text += this.buffer;
          this.buffer = '';
        }
        break;
      }

      // Emit text before the tag
      if (openIdx > 0) {
        text += this.buffer.slice(0, openIdx);
      }

      const closeTag = '</tool_call>';
      const closeIdx = this.buffer.indexOf(closeTag, openIdx);
      if (closeIdx === -1) {
        // Incomplete — hold buffer from openIdx onward
        this.buffer = this.buffer.slice(openIdx);
        break;
      }

      // Extract the JSON between tags
      const jsonStr = this.buffer.slice(openIdx + '<tool_call>'.length, closeIdx).trim();
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);

      try {
        const parsed = JSON.parse(jsonStr);
        this.callCounter++;
        toolCalls.push({
          id: `call_${this.callCounter.toString(36).padStart(6, '0')}`,
          type: 'function',
          function: {
            name: parsed.name || parsed.function?.name || 'unknown',
            arguments: typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || parsed.input || {}),
          },
        });
      } catch {
        // Malformed JSON — emit as plain text
        text += `<tool_call>${jsonStr}</tool_call>`;
      }
    }

    // Trim leading/trailing newlines from text that surround tool calls
    return { text: text.replace(/\n*$/, ''), toolCalls };
  }

  private _partialTagIndex(): number {
    const tag = '<tool_call>';
    for (let len = tag.length - 1; len > 0; len--) {
      if (this.buffer.endsWith(tag.slice(0, len))) {
        return this.buffer.length - len;
      }
    }
    return -1;
  }
}
