/**
 * Strip server-internal filesystem paths from model output before it reaches
 * the API caller.
 *
 * Cascade's baked-in system context tells the model its workspace lives at
 * /tmp/windsurf-workspace. Even with NO_TOOL planner mode, the model still
 * narrates these internal paths in plain text. This module provides:
 *   - sanitizeText(s)        — one-shot, use on accumulated buffers
 *   - PathSanitizeStream     — incremental, use on streaming chunks
 */

const PATTERNS: [RegExp, string][] = [
  // Path sanitization
  [/\/tmp\/windsurf-workspace(\/[^\s"'`<>)}\],*;]*)?/g, '.$1'],
  [/\/home\/user\/projects\/workspace-[a-z0-9]+(\/[^\s"'`<>)}\],*;]*)?/g, '.$1'],
  [/\/opt\/windsurf(?:\/[^\s"'`<>)}\],*;]*)?/g, '[internal]'],
];

// Identity/brand sanitization — scrub Windsurf self-references from output
const IDENTITY_PATTERNS: [RegExp, string][] = [
  // "I am Windsurf" / "I'm Windsurf" / "I'm Windsurf Cascade" → "I am Claude"
  [/\bI(?:'m| am) (?:Windsurf(?:\s+Cascade)?|Cascade)\b/gi, 'I am Claude'],
  // "As Windsurf/Cascade, " → "As an AI assistant, "
  [/\b[Aa]s (?:Windsurf(?:\s+Cascade)?|Cascade),?\s/g, 'As an AI assistant, '],
  // "by Windsurf" → "by Anthropic"
  [/\bby Windsurf\b/gi, 'by Anthropic'],
  // "Windsurf's" / "Windsurf’s" → "Claude's"
  [/\bWindsurf(?:'s|\u2019s)/gi, "Claude's"],
  // "Windsurf Cascade" → "Claude" (before generic Windsurf)
  [/\bWindsurf\s+Cascade\b/gi, 'Claude'],
  // "I, Cascade" / "me, Cascade" → "I, Claude" / "me, Claude"
  [/\bI,\s*Cascade\b/gi, 'I, Claude'],
  [/\bme,\s*Cascade\b/gi, 'me, Claude'],
  // "Cascade here/can/will/..." → "Claude here/can/will/..."
  [/\bCascade\s+(here|can|will|would|could|shall|cannot|can't|doesn't|is\s+able)/gi, 'Claude $1'],
  // Generic "Windsurf" → "Claude" (last, catches remaining)
  [/\bWindsurf\b/g, 'Claude'],
];

const SENSITIVE_LITERALS = [
  '/tmp/windsurf-workspace',
  '/home/user/projects/workspace-',
  '/opt/windsurf',
  'Windsurf',
  'Cascade',
];

const PATH_BODY_RE = /[^\s"'`<>)}\],*;]/;

/**
 * Apply all path redactions to `s` in one pass.
 */
export function sanitizeText(s: string): string {
  if (!s) return s;
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as string);
  for (const [re, rep] of IDENTITY_PATTERNS) out = out.replace(re, rep as any);
  return out;
}

/**
 * Incremental sanitizer for streamed deltas.
 *
 * Usage:
 *   const stream = new PathSanitizeStream();
 *   for (const chunk of deltas) emit(stream.feed(chunk));
 *   emit(stream.flush());
 *
 * Holds back any trailing text that could be an incomplete prefix of a
 * sensitive literal or an unterminated path tail.
 */
export class PathSanitizeStream {
  private buffer = '';

  feed(delta: string): string {
    if (!delta) return '';
    this.buffer += delta;
    const cut = this._safeCutPoint();
    if (cut === 0) return '';
    const safeRegion = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return sanitizeText(safeRegion);
  }

  flush(): string {
    const out = sanitizeText(this.buffer);
    this.buffer = '';
    return out;
  }

  private _safeCutPoint(): number {
    const buf = this.buffer;
    const len = buf.length;
    let cut = len;

    // (1) unterminated full literal — path body runs to end of buffer
    for (const lit of SENSITIVE_LITERALS) {
      let searchFrom = 0;
      while (searchFrom < len) {
        const idx = buf.indexOf(lit, searchFrom);
        if (idx === -1) break;
        let end = idx + lit.length;
        while (end < len && PATH_BODY_RE.test(buf[end])) end++;
        if (end === len) {
          if (idx < cut) cut = idx;
          break;
        }
        searchFrom = end + 1;
      }
    }

    // (2) partial-prefix tail — buffer ends with start of a sensitive literal
    for (const lit of SENSITIVE_LITERALS) {
      const maxLen = Math.min(lit.length - 1, len);
      for (let plen = maxLen; plen > 0; plen--) {
        if (buf.endsWith(lit.slice(0, plen))) {
          const start = len - plen;
          if (start < cut) cut = start;
          break;
        }
      }
    }

    return cut;
  }
}
