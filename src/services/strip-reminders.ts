/**
 * Strip problematic content from messages before forwarding to Windsurf Cascade.
 *
 * Two concerns:
 * 1. <system-reminder> blocks: Claude Code injects safety reminders, TodoWrite
 *    nudges, etc. that confuse non-Anthropic models and cause false refusals.
 * 2. Claude Code system prompt: a massive boilerplate ("You are Claude, made by
 *    Anthropic…", tool definitions, safety guidelines) that triggers Windsurf's
 *    content policy filter. We detect and strip it entirely — Cascade has its
 *    own persona.
 */

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const REMINDER_OPEN_TAG = '<system-reminder>';

/** Patterns that identify Claude Code's boilerplate system prompt */
const CLAUDE_CODE_INDICATORS = [
  'You are Claude',
  'made by Anthropic',
  'You are an interactive',
  'TOOL_RESULT',
  'IMPORTANT: Refuse to write code or explain techniques',
  'tool_use_id',
  'TodoWrite',
  'You have access to a set of tools',
  '<tool_name>',
  'bash tool',
  'You are a coding',
  'Human turns may include `tool_result`',
  'search_and_replace',
];

/**
 * Detect whether a system prompt is Claude Code's boilerplate.
 * Returns true if ≥3 indicators match (very reliable heuristic).
 */
function isClaudeCodeSystemPrompt(text: string): boolean {
  if (text.length < 500) return false; // Real boilerplate is huge
  let hits = 0;
  for (const indicator of CLAUDE_CODE_INDICATORS) {
    if (text.includes(indicator)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

/** Patterns in user messages that trigger Windsurf's content filter */
const CONTENT_POLICY_PATTERNS = [
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<system-instructions>[\s\S]*?<\/system-instructions>/g,
  /IMPORTANT:\s*Refuse to write code or explain techniques[\s\S]*?(?=\n\n|\n[A-Z]|$)/g,
];

export function stripText(s: string): string {
  let result = s;
  // Strip <system-reminder> blocks
  if (result.includes(REMINDER_OPEN_TAG)) {
    result = result.replace(REMINDER_RE, '');
  }
  // Strip other content-policy-triggering patterns
  for (const pat of CONTENT_POLICY_PATTERNS) {
    result = result.replace(pat, '');
  }
  if (result === s) return s; // unchanged — return original ref
  return result
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip the system prompt from a text that contains Claude Code boilerplate.
 * Returns undefined if the entire prompt should be dropped.
 */
function sanitizeSystemText(text: string): string | undefined {
  // First strip <system-reminder> blocks
  const stripped = stripText(text);
  // Then check if it's Claude Code boilerplate
  if (isClaudeCodeSystemPrompt(stripped)) {
    return undefined; // Drop entirely — Cascade has its own persona
  }
  return stripped || undefined;
}

export function stripMessagesPayload(body: any): any {
  if (!body) return body;
  let changed = false;

  // Sanitize system field — drop Claude Code boilerplate entirely
  let newSystem = body.system;
  if (typeof body.system === 'string') {
    const sanitized = sanitizeSystemText(body.system);
    if (sanitized !== body.system) {
      newSystem = sanitized;
      changed = true;
    }
  } else if (Array.isArray(body.system)) {
    const fullText = body.system
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    if (isClaudeCodeSystemPrompt(fullText)) {
      // Drop entire system prompt array — it's Claude Code boilerplate
      newSystem = undefined;
      changed = true;
    } else {
      const out: any[] = [];
      for (const b of body.system) {
        if (b.type === 'text') {
          const t = stripText(b.text);
          if (t.length === 0) { changed = true; continue; }
          if (t !== b.text) { changed = true; out.push({ ...b, text: t }); }
          else out.push(b);
        } else {
          out.push(b);
        }
      }
      if (changed) newSystem = out.length > 0 ? out : undefined;
    }
  }

  // Strip <system-reminder> from user/assistant messages
  let newMessages = body.messages;
  if (Array.isArray(body.messages)) {
    const msgs = body.messages.map((m: any) => {
      if (typeof m.content === 'string') {
        const s = stripText(m.content);
        if (s !== m.content) { changed = true; return { ...m, content: s }; }
        return m;
      }
      if (!Array.isArray(m.content)) return m;

      const hasReminder = m.content.some((b: any) =>
        (b.type === 'text' && typeof b.text === 'string' && b.text.includes(REMINDER_OPEN_TAG)) ||
        (b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes(REMINDER_OPEN_TAG))
      );
      if (!hasReminder) return m;

      changed = true;
      const out: any[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = stripText(b.text);
          if (t.length === 0) continue;
          out.push(t === b.text ? b : { ...b, text: t });
        } else if (b.type === 'tool_result' && typeof b.content === 'string') {
          const t = stripText(b.content);
          out.push(t === b.content ? b : { ...b, content: t.length === 0 ? ' ' : t });
        } else {
          out.push(b);
        }
      }
      return { ...m, content: out };
    });
    if (changed) newMessages = msgs;
  }

  if (!changed) return body;
  return { ...body, system: newSystem, messages: newMessages };
}
