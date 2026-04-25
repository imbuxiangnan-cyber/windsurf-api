/**
 * Strip <system-reminder> blocks from messages.
 * Claude Code injects these tags (safety reminders, TodoWrite nudges, etc.)
 * which confuse non-Anthropic upstream models and cause false refusals.
 * Ported from copilot-api-plus.
 */

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const REMINDER_OPEN_TAG = '<system-reminder>';

export function stripText(s: string): string {
  if (!s.includes(REMINDER_OPEN_TAG)) return s;
  return s
    .replace(REMINDER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripMessagesPayload(body: any): any {
  if (!body) return body;
  let changed = false;

  // Strip system field
  let newSystem = body.system;
  if (typeof body.system === 'string') {
    const stripped = stripText(body.system);
    if (stripped !== body.system) { newSystem = stripped; changed = true; }
  } else if (Array.isArray(body.system)) {
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
    if (changed) newSystem = out;
  }

  // Strip messages
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
