/**
 * Token counting endpoint for Anthropic Messages API.
 * Claude Code calls /v1/messages/count_tokens to decide when to compact.
 * Returns an approximate token count.
 */

import http from 'http';
import { log } from '../config.js';

function json(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

/**
 * Rough token counter — counts ~4 chars per token (approximation).
 * For more accuracy, gpt-tokenizer could be added as dependency.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function countMessageTokens(messages: any[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += 3; // per-message overhead
    if (typeof msg.content === 'string') {
      tokens += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          tokens += estimateTokens(block.text);
        } else if (block.type === 'thinking' && block.thinking) {
          tokens += estimateTokens(block.thinking);
        } else if (block.type === 'tool_use') {
          tokens += estimateTokens(block.name || '');
          tokens += estimateTokens(JSON.stringify(block.input || {}));
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map((b: any) => b.text || '').join('\n') : '';
          tokens += estimateTokens(content);
        } else if (block.type === 'image') {
          tokens += 85; // image overhead
        }
      }
    }
    if (msg.role) tokens += 1;
    if (msg.name) tokens += estimateTokens(msg.name) + 1;
  }
  tokens += 3; // reply priming
  return tokens;
}

function countToolTokens(tools: any[]): number {
  if (!tools || !Array.isArray(tools)) return 0;
  let tokens = 0;
  for (const tool of tools) {
    tokens += 7; // func init
    if (tool.name) tokens += estimateTokens(tool.name);
    if (tool.description) tokens += estimateTokens(tool.description);
    if (tool.input_schema) tokens += estimateTokens(JSON.stringify(tool.input_schema));
  }
  tokens += 12; // func end
  return tokens;
}

export async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
): Promise<void> {
  try {
    const messages: any[] = [];
    // System prompt
    if (body.system) {
      if (typeof body.system === 'string') {
        messages.push({ role: 'system', content: body.system });
      } else if (Array.isArray(body.system)) {
        messages.push({ role: 'system', content: body.system.map((b: any) => b.text || '').join('\n') });
      }
    }
    if (Array.isArray(body.messages)) {
      messages.push(...body.messages);
    }

    let inputTokens = countMessageTokens(messages);

    // Tool definitions
    if (body.tools && body.tools.length > 0) {
      inputTokens += countToolTokens(body.tools);
      // Tool overhead for Claude models
      if (body.model?.startsWith('claude')) {
        const anthropicBeta = req.headers['anthropic-beta'];
        const hasMcpTools = body.tools.some((t: any) => t.name?.startsWith('mcp__'));
        if (typeof anthropicBeta === 'string' && anthropicBeta.startsWith('claude-code') && !hasMcpTools) {
          // No extra overhead for claude-code with non-MCP tools
        } else {
          inputTokens += 346;
        }
      }
    }

    // Apply model-specific multiplier
    if (body.model?.startsWith('claude')) {
      inputTokens = Math.round(inputTokens * 1.15);
    }

    log.debug(`count_tokens: model=${body.model} tokens=${inputTokens}`);
    json(res, 200, { input_tokens: inputTokens });
  } catch (err: any) {
    log.warn(`count_tokens error: ${err.message}`);
    // Return 1 as fallback — copilot-api-plus does the same
    json(res, 200, { input_tokens: 1 });
  }
}
