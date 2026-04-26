/**
 * Model catalog for Windsurf API.
 */

import { ModelInfo } from './types.js';

export type { ModelInfo };

export const MODELS: Record<string, ModelInfo> = {
  // ── Claude ──────────────────────────────────────────────
  'claude-3.5-sonnet':              { name: 'claude-3.5-sonnet',              provider: 'anthropic', enumValue: 166, modelUid: null, credit: 2 },
  'claude-3.7-sonnet':              { name: 'claude-3.7-sonnet',              provider: 'anthropic', enumValue: 226, modelUid: null, credit: 2 },
  'claude-3.7-sonnet-thinking':     { name: 'claude-3.7-sonnet-thinking',     provider: 'anthropic', enumValue: 227, modelUid: null, credit: 3 },
  'claude-4-sonnet':                { name: 'claude-4-sonnet',                provider: 'anthropic', enumValue: 281, modelUid: 'MODEL_CLAUDE_4_SONNET', credit: 2 },
  'claude-4-sonnet-thinking':       { name: 'claude-4-sonnet-thinking',       provider: 'anthropic', enumValue: 282, modelUid: 'MODEL_CLAUDE_4_SONNET_THINKING', credit: 3 },
  'claude-4-opus':                  { name: 'claude-4-opus',                  provider: 'anthropic', enumValue: 290, modelUid: 'MODEL_CLAUDE_4_OPUS', credit: 4 },
  'claude-4-opus-thinking':         { name: 'claude-4-opus-thinking',         provider: 'anthropic', enumValue: 291, modelUid: 'MODEL_CLAUDE_4_OPUS_THINKING', credit: 5 },
  'claude-4.1-opus':                { name: 'claude-4.1-opus',                provider: 'anthropic', enumValue: 328, modelUid: 'MODEL_CLAUDE_4_1_OPUS', credit: 4 },
  'claude-4.1-opus-thinking':       { name: 'claude-4.1-opus-thinking',       provider: 'anthropic', enumValue: 329, modelUid: 'MODEL_CLAUDE_4_1_OPUS_THINKING', credit: 5 },
  'claude-4.5-haiku':               { name: 'claude-4.5-haiku',               provider: 'anthropic', enumValue: 0,   modelUid: 'MODEL_PRIVATE_11', credit: 1 },
  'claude-4.5-sonnet':              { name: 'claude-4.5-sonnet',              provider: 'anthropic', enumValue: 353, modelUid: 'MODEL_PRIVATE_2', credit: 2 },
  'claude-4.5-sonnet-thinking':     { name: 'claude-4.5-sonnet-thinking',     provider: 'anthropic', enumValue: 354, modelUid: 'MODEL_PRIVATE_3', credit: 3 },
  'claude-4.5-opus':                { name: 'claude-4.5-opus',                provider: 'anthropic', enumValue: 391, modelUid: 'MODEL_CLAUDE_4_5_OPUS', credit: 4 },
  'claude-4.5-opus-thinking':       { name: 'claude-4.5-opus-thinking',       provider: 'anthropic', enumValue: 392, modelUid: 'MODEL_CLAUDE_4_5_OPUS_THINKING', credit: 5 },
  'claude-sonnet-4.6':              { name: 'claude-sonnet-4.6',              provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6', credit: 4 },
  'claude-sonnet-4.6-thinking':     { name: 'claude-sonnet-4.6-thinking',     provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-thinking', credit: 6 },
  'claude-sonnet-4.6-1m':           { name: 'claude-sonnet-4.6-1m',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-1m', credit: 12 },
  'claude-sonnet-4.6-thinking-1m':  { name: 'claude-sonnet-4.6-thinking-1m',  provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-thinking-1m', credit: 16 },
  'claude-opus-4.6':                { name: 'claude-opus-4.6',                provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6', credit: 6 },
  'claude-opus-4.6-thinking':       { name: 'claude-opus-4.6-thinking',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6-thinking', credit: 8 },
  'claude-opus-4.7-low':            { name: 'claude-opus-4.7-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-low', credit: 7 },
  'claude-opus-4.7-medium':         { name: 'claude-opus-4.7-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-medium', credit: 10 },
  'claude-opus-4.7-high':           { name: 'claude-opus-4.7-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-high', credit: 14 },
  'claude-opus-4.7-xhigh':          { name: 'claude-opus-4.7-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-xhigh', credit: 16 },
  'claude-opus-4.7-max':            { name: 'claude-opus-4.7-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-max', credit: 30 },

  // ── GPT ─────────────────────────────────────────────────
  'gpt-4o':                         { name: 'gpt-4o',                         provider: 'openai', enumValue: 109, modelUid: 'MODEL_CHAT_GPT_4O_2024_08_06', credit: 1 },
  'gpt-4o-mini':                    { name: 'gpt-4o-mini',                    provider: 'openai', enumValue: 113, modelUid: null, credit: 0.5 },
  'gpt-4.1':                        { name: 'gpt-4.1',                        provider: 'openai', enumValue: 259, modelUid: 'MODEL_CHAT_GPT_4_1_2025_04_14', credit: 1 },
  'gpt-4.1-mini':                   { name: 'gpt-4.1-mini',                   provider: 'openai', enumValue: 260, modelUid: null, credit: 0.5 },
  'gpt-4.1-nano':                   { name: 'gpt-4.1-nano',                   provider: 'openai', enumValue: 261, modelUid: null, credit: 0.25 },
  'gpt-5':                          { name: 'gpt-5',                          provider: 'openai', enumValue: 340, modelUid: 'MODEL_PRIVATE_6', credit: 0.5 },
  'gpt-5-medium':                   { name: 'gpt-5-medium',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_7', credit: 1 },
  'gpt-5-high':                     { name: 'gpt-5-high',                     provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_8', credit: 2 },
  'gpt-5-mini':                     { name: 'gpt-5-mini',                     provider: 'openai', enumValue: 337, modelUid: null, credit: 0.25 },
  'gpt-5-codex':                    { name: 'gpt-5-codex',                    provider: 'openai', enumValue: 346, modelUid: 'MODEL_CHAT_GPT_5_CODEX', credit: 0.5 },
  // GPT-5.1
  'gpt-5.1':                        { name: 'gpt-5.1',                        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_12', credit: 0.5 },
  'gpt-5.1-low':                    { name: 'gpt-5.1-low',                    provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_13', credit: 0.5 },
  'gpt-5.1-medium':                 { name: 'gpt-5.1-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_14', credit: 1 },
  'gpt-5.1-high':                   { name: 'gpt-5.1-high',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_15', credit: 2 },
  'gpt-5.1-fast':                   { name: 'gpt-5.1-fast',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_20', credit: 1 },
  // GPT-5.2
  'gpt-5.2':                        { name: 'gpt-5.2',                        provider: 'openai', enumValue: 401, modelUid: 'MODEL_GPT_5_2_MEDIUM', credit: 2 },
  'gpt-5.2-low':                    { name: 'gpt-5.2-low',                    provider: 'openai', enumValue: 400, modelUid: 'MODEL_GPT_5_2_LOW', credit: 1 },
  'gpt-5.2-high':                   { name: 'gpt-5.2-high',                   provider: 'openai', enumValue: 402, modelUid: 'MODEL_GPT_5_2_HIGH', credit: 3 },
  'gpt-5.2-xhigh':                  { name: 'gpt-5.2-xhigh',                  provider: 'openai', enumValue: 403, modelUid: 'MODEL_GPT_5_2_XHIGH', credit: 8 },
  // GPT-5.4
  'gpt-5.4-none':                   { name: 'gpt-5.4-none',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-none', credit: 0.5 },
  'gpt-5.4-low':                    { name: 'gpt-5.4-low',                    provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-low', credit: 1 },
  'gpt-5.4-medium':                 { name: 'gpt-5.4-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-medium', credit: 2 },
  'gpt-5.4-high':                   { name: 'gpt-5.4-high',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-high', credit: 4 },
  'gpt-5.4-xhigh':                  { name: 'gpt-5.4-xhigh',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-xhigh', credit: 8 },
  // GPT-OSS
  'gpt-oss-120b':                   { name: 'gpt-oss-120b',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_OSS_120B', credit: 0.25 },

  // ── O-series ────────────────────────────────────────────
  'o3-mini':                        { name: 'o3-mini',                        provider: 'openai', enumValue: 207, modelUid: null, credit: 0.5 },
  'o3':                             { name: 'o3',                             provider: 'openai', enumValue: 218, modelUid: 'MODEL_CHAT_O3', credit: 1 },
  'o3-high':                        { name: 'o3-high',                        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_CHAT_O3_HIGH', credit: 1 },
  'o3-pro':                         { name: 'o3-pro',                         provider: 'openai', enumValue: 294, modelUid: null, credit: 4 },
  'o4-mini':                        { name: 'o4-mini',                        provider: 'openai', enumValue: 264, modelUid: null, credit: 0.5 },

  // ── Gemini ──────────────────────────────────────────────
  'gemini-2.5-pro':                 { name: 'gemini-2.5-pro',                 provider: 'google', enumValue: 246, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_PRO', credit: 1 },
  'gemini-2.5-flash':               { name: 'gemini-2.5-flash',               provider: 'google', enumValue: 312, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', credit: 0.5 },
  'gemini-3.0-pro':                 { name: 'gemini-3.0-pro',                 provider: 'google', enumValue: 412, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_PRO_LOW', credit: 1 },
  'gemini-3.0-flash-minimal':       { name: 'gemini-3.0-flash-minimal',       provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL', credit: 0.75 },
  'gemini-3.0-flash-low':           { name: 'gemini-3.0-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW', credit: 1 },
  'gemini-3.0-flash':               { name: 'gemini-3.0-flash',               provider: 'google', enumValue: 415, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM', credit: 1 },
  'gemini-3.0-flash-high':          { name: 'gemini-3.0-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH', credit: 1.75 },
  'gemini-3.1-pro-low':             { name: 'gemini-3.1-pro-low',             provider: 'google', enumValue: 0,   modelUid: 'gemini-3-1-pro-low', credit: 1 },
  'gemini-3.1-pro-high':            { name: 'gemini-3.1-pro-high',            provider: 'google', enumValue: 0,   modelUid: 'gemini-3-1-pro-high', credit: 2 },

  // ── DeepSeek ────────────────────────────────────────────
  'deepseek-v3':                    { name: 'deepseek-v3',                    provider: 'deepseek', enumValue: 205, modelUid: null, credit: 0.5 },
  'deepseek-v3-2':                  { name: 'deepseek-v3-2',                  provider: 'deepseek', enumValue: 409, modelUid: null, credit: 0.5 },
  'deepseek-r1':                    { name: 'deepseek-r1',                    provider: 'deepseek', enumValue: 206, modelUid: null, credit: 1 },

  // ── Grok ────────────────────────────────────────────────
  'grok-3':                         { name: 'grok-3',                         provider: 'xai', enumValue: 217, modelUid: 'MODEL_XAI_GROK_3', credit: 1 },
  'grok-3-mini':                    { name: 'grok-3-mini',                    provider: 'xai', enumValue: 234, modelUid: null, credit: 0.5 },
  'grok-3-mini-thinking':           { name: 'grok-3-mini-thinking',           provider: 'xai', enumValue: 0,   modelUid: 'MODEL_XAI_GROK_3_MINI_REASONING', credit: 0.125 },
  'grok-code-fast-1':               { name: 'grok-code-fast-1',               provider: 'xai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_4', credit: 0.5 },

  // ── Qwen ────────────────────────────────────────────────
  'qwen-3':                         { name: 'qwen-3',                         provider: 'alibaba', enumValue: 324, modelUid: null, credit: 0.5 },
  'qwen-3-coder':                   { name: 'qwen-3-coder',                   provider: 'alibaba', enumValue: 0,   modelUid: 'qwen-3-coder', credit: 1 },

  // ── Kimi ────────────────────────────────────────────────
  'kimi-k2':                        { name: 'kimi-k2',                        provider: 'moonshot', enumValue: 323, modelUid: 'MODEL_KIMI_K2', credit: 0.5 },
  'kimi-k2.5':                      { name: 'kimi-k2.5',                      provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k2-5', credit: 1 },

  // ── GLM ─────────────────────────────────────────────────
  'glm-4.7':                        { name: 'glm-4.7',                        provider: 'zhipu', enumValue: 417, modelUid: 'MODEL_GLM_4_7', credit: 0.25 },
  'glm-5':                          { name: 'glm-5',                          provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5', credit: 1.5 },
  'glm-5.1':                        { name: 'glm-5.1',                        provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-1', credit: 1.5 },

  // ── MiniMax ─────────────────────────────────────────────
  'minimax-m2.5':                   { name: 'minimax-m2.5',                   provider: 'minimax', enumValue: 0,   modelUid: 'minimax-m2-5', credit: 1 },

  // ── Windsurf SWE ────────────────────────────────────────
  'swe-1.5':                        { name: 'swe-1.5',                        provider: 'windsurf', enumValue: 369, modelUid: 'MODEL_SWE_1_5_SLOW', credit: 0.5 },
  'swe-1.5-fast':                   { name: 'swe-1.5-fast',                   provider: 'windsurf', enumValue: 359, modelUid: 'MODEL_SWE_1_5', credit: 0.5 },
  'swe-1.6':                        { name: 'swe-1.6',                        provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-6', credit: 0.5 },
  'swe-1.6-fast':                   { name: 'swe-1.6-fast',                   provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-6-fast', credit: 0.5 },

  // ── Arena ───────────────────────────────────────────────
  'arena-fast':                     { name: 'arena-fast',                     provider: 'windsurf', enumValue: 0,   modelUid: 'arena-fast', credit: 0.5 },
  'arena-smart':                    { name: 'arena-smart',                    provider: 'windsurf', enumValue: 0,   modelUid: 'arena-smart', credit: 1 },
};

// Build lookup table
const _lookup = new Map<string, string>();
for (const [id, info] of Object.entries(MODELS)) {
  _lookup.set(id, id);
  _lookup.set(id.toLowerCase(), id);
  _lookup.set(info.name, id);
  _lookup.set(info.name.toLowerCase(), id);
  if (info.modelUid) {
    _lookup.set(info.modelUid, id);
    _lookup.set(info.modelUid.toLowerCase(), id);
  }
}

// ── Anthropic official dated names ─────────────────────────
const ANTHROPIC_DATED: Record<string, string> = {
  'claude-3-5-sonnet-20240620': 'claude-3.5-sonnet',
  'claude-3-5-sonnet-20241022': 'claude-3.5-sonnet',
  'claude-3-5-sonnet-latest':   'claude-3.5-sonnet',
  'claude-3-7-sonnet-20250219': 'claude-3.7-sonnet',
  'claude-3-7-sonnet-latest':   'claude-3.7-sonnet',
  'claude-sonnet-4-20250514':   'claude-4-sonnet',
  'claude-sonnet-4-0':          'claude-4-sonnet',
  'claude-opus-4-20250514':     'claude-4-opus',
  'claude-opus-4-0':            'claude-4-opus',
  'claude-opus-4-1':            'claude-4.1-opus',
  'claude-opus-4-1-20250805':   'claude-4.1-opus',
  'claude-sonnet-4-5':          'claude-4.5-sonnet',
  'claude-sonnet-4-5-20250929': 'claude-4.5-sonnet',
  'claude-opus-4-5':            'claude-4.5-opus',
  'claude-opus-4-5-20251101':   'claude-4.5-opus',
  'claude-opus-4-7':            'claude-opus-4.7-medium',
  'claude-opus-4-7-latest':     'claude-opus-4.7-medium',
  'claude-opus-4.7':            'claude-opus-4.7-medium',
  'claude-opus-4.7-thinking':   'claude-opus-4.7-medium',
};
for (const [k, v] of Object.entries(ANTHROPIC_DATED)) _lookup.set(k, v);

// ── OpenAI official dated names ───────────────────────────
const OPENAI_DATED: Record<string, string> = {
  'gpt-4o-2024-11-20':       'gpt-4o',
  'gpt-4o-2024-08-06':       'gpt-4o',
  'gpt-4o-2024-05-13':       'gpt-4o',
  'gpt-4o-mini-2024-07-18':  'gpt-4o-mini',
  'gpt-4.1-2025-04-14':      'gpt-4.1',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4.1-nano-2025-04-14': 'gpt-4.1-nano',
  'gpt-5-2025-08-07':        'gpt-5',
  'gpt-5-pro-2025-10-06':    'gpt-5-high',
};
for (const [k, v] of Object.entries(OPENAI_DATED)) _lookup.set(k, v);

// ── Cursor-friendly aliases (bypass "claude" keyword filter) ──
const CURSOR_ALIASES: Record<string, string> = {
  'opus-4.6':            'claude-opus-4.6',
  'opus-4.6-thinking':   'claude-opus-4.6-thinking',
  'opus-4-7':            'claude-opus-4.7-medium',
  'opus-4.7':            'claude-opus-4.7-medium',
  'opus-4.7-low':        'claude-opus-4.7-low',
  'opus-4.7-high':       'claude-opus-4.7-high',
  'opus-4.7-xhigh':     'claude-opus-4.7-xhigh',
  'opus-4.7-max':        'claude-opus-4.7-max',
  'sonnet-4.6':          'claude-sonnet-4.6',
  'sonnet-4.6-thinking': 'claude-sonnet-4.6-thinking',
  'sonnet-4.6-1m':       'claude-sonnet-4.6-1m',
  'sonnet-4.5':          'claude-4.5-sonnet',
  'sonnet-4.5-thinking': 'claude-4.5-sonnet-thinking',
  'haiku-4.5':           'claude-4.5-haiku',
  'sonnet-4':            'claude-4-sonnet',
  'opus-4':              'claude-4-opus',
  'opus-4.1':            'claude-4.1-opus',
  'sonnet-3.7':          'claude-3.7-sonnet',
  'sonnet-3.5':          'claude-3.5-sonnet',
  'ws-opus':             'claude-opus-4.6',
  'ws-sonnet':           'claude-sonnet-4.6',
  'ws-opus-thinking':    'claude-opus-4.6-thinking',
  'ws-sonnet-thinking':  'claude-sonnet-4.6-thinking',
  'ws-haiku':            'claude-4.5-haiku',
};
for (const [k, v] of Object.entries(CURSOR_ALIASES)) _lookup.set(k, v);

// ── General aliases ───────────────────────────────────────
const ALIASES: Record<string, string> = {
  // Legacy model redirects
  'gpt-3.5-turbo': 'gpt-4o-mini',
  'gpt-4': 'gpt-4o',
  'gpt-4-turbo': 'gpt-4o',
  // CC bare aliases
  'opus':   'claude-opus-4.6-thinking',
  'sonnet': 'claude-sonnet-4.6',
  'haiku':  'claude-4.5-haiku',
  // Claude short forms
  'claude-3-5-sonnet': 'claude-3.5-sonnet',
  'claude-3-5-sonnet-latest': 'claude-3.5-sonnet',
  'claude-sonnet': 'claude-sonnet-4.6',
  'claude-3-opus': 'claude-opus-4.6',
  'claude-3-opus-20240229': 'claude-opus-4.6',
  'claude-opus': 'claude-opus-4.6-thinking',
  'claude-3-5-haiku': 'claude-4.5-haiku',
  'claude-haiku': 'claude-4.5-haiku',
  // Dash ↔ dot forms for Sonnet/Opus 4.6
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6-thinking',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-6-thinking-1m': 'claude-sonnet-4.6-thinking-1m',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-thinking': 'claude-opus-4.6-thinking',
  // Opus 4.7 dash forms
  'claude-opus-4-7-low':    'claude-opus-4.7-low',
  'claude-opus-4-7-medium': 'claude-opus-4.7-medium',
  'claude-opus-4-7-high':   'claude-opus-4.7-high',
  'claude-opus-4-7-xhigh':  'claude-opus-4.7-xhigh',
  'claude-opus-4-7-max':    'claude-opus-4.7-max',
  // Gemini aliases
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  'gemini-flash': 'gemini-3.0-flash',
  // UID-form aliases for models using MODEL_ prefix UIDs
  'MODEL_CLAUDE_4_5_SONNET': 'claude-4.5-sonnet',
  'MODEL_CLAUDE_4_5_SONNET_THINKING': 'claude-4.5-sonnet-thinking',
};
for (const [alias, target] of Object.entries(ALIASES)) {
  _lookup.set(alias, target);
  _lookup.set(alias.toLowerCase(), target);
}

export function resolveModel(name: string): string | null {
  const clean = name.replace(/\u001b\[[0-9;]*m/g, '').trim();

  // 1. Direct match
  const direct = _lookup.get(clean) || _lookup.get(clean.toLowerCase());
  if (direct) return direct;

  // 2. Strip date suffix: claude-opus-4-6-20251101 → claude-opus-4-6
  const noDate = clean.replace(/-\d{8}$/, '');
  if (noDate !== clean) {
    const m = _lookup.get(noDate) || _lookup.get(noDate.toLowerCase());
    if (m) return m;
  }

  // 3. Dash → dot: claude-opus-4-6 → claude-opus-4.6
  const withDot = noDate.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  if (withDot !== noDate) {
    const m = _lookup.get(withDot) || _lookup.get(withDot.toLowerCase());
    if (m) return m;
  }

  // 4. Dot → dash: claude-opus-4.6 → claude-opus-4-6
  const withDash = clean.replace(/(\d+)\.(\d+)/, '$1-$2');
  if (withDash !== clean) {
    const m = _lookup.get(withDash) || _lookup.get(withDash.toLowerCase());
    if (m) return m;
  }

  return null;
}

export function getModelInfo(id: string): ModelInfo | null {
  return MODELS[id] || null;
}

export function listModels() {
  const ts = Math.floor(Date.now() / 1000);
  return Object.entries(MODELS).map(([_id, info]) => ({
    id: info.name,
    object: 'model' as const,
    created: ts,
    owned_by: info.provider,
  }));
}

/** Check if a model key is a thinking-capable model */
export function isThinkingModel(id: string): boolean {
  return id.includes('thinking') || id.includes('opus-4-7') || id.includes('opus-4.7');
}

export function listAnthropicModels() {
  const now = new Date().toISOString();
  const cap = { supported: true };
  // All Claude models report thinking capability — Cascade enables it via brain config.
  // Thinking-dedicated models get both adaptive + enabled; others get enabled only.
  const capThinkingFull = { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } };
  const capThinkingBasic = { supported: true, types: { enabled: { supported: true } } };

  const claudeModels = Object.entries(MODELS)
    .filter(([_, info]) => info.provider === 'anthropic')
    .map(([id, info]) => ({
      type: 'model' as const,
      id: info.modelUid || id,
      display_name: info.name,
      created_at: now,
      max_tokens: id.includes('opus') ? 128000 : 64000,
      capabilities: {
        code_execution: cap,
        thinking: isThinkingModel(id) ? capThinkingFull : capThinkingBasic,
        structured_outputs: cap,
        image_input: cap,
      },
    }));

  return {
    data: claudeModels,
    has_more: false,
    first_id: claudeModels[0]?.id || '',
    last_id: claudeModels[claudeModels.length - 1]?.id || '',
  };
}
