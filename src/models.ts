/**
 * Model catalog for Windsurf API.
 */

import { ModelInfo } from './types.js';

export type { ModelInfo };

export const MODELS: Record<string, ModelInfo> = {
  // Claude
  'claude-3.5-sonnet': { name: 'claude-3.5-sonnet', provider: 'anthropic', enumValue: 0, modelUid: 'claude-3-5-sonnet', credit: 2 },
  'claude-3.7-sonnet': { name: 'claude-3.7-sonnet', provider: 'anthropic', enumValue: 0, modelUid: 'claude-3-7-sonnet', credit: 3 },
  'claude-3.7-sonnet-thinking': { name: 'claude-3.7-sonnet-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-3-7-sonnet-thinking', credit: 4 },
  'claude-4-sonnet': { name: 'claude-4-sonnet', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-sonnet', credit: 3 },
  'claude-4-sonnet-thinking': { name: 'claude-4-sonnet-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-sonnet-thinking', credit: 4 },
  'claude-4-opus': { name: 'claude-4-opus', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-opus', credit: 5 },
  'claude-4-opus-thinking': { name: 'claude-4-opus-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-opus-thinking', credit: 6 },
  'claude-4.5-sonnet': { name: 'claude-4.5-sonnet', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-5-sonnet', credit: 3 },
  'claude-4.5-sonnet-thinking': { name: 'claude-4.5-sonnet-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-5-sonnet-thinking', credit: 4 },
  'claude-4.5-haiku': { name: 'claude-4.5-haiku', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-5-haiku', credit: 1 },
  'claude-4.5-opus': { name: 'claude-4.5-opus', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-5-opus', credit: 5 },
  'claude-4.5-opus-thinking': { name: 'claude-4.5-opus-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-4-5-opus-thinking', credit: 6 },
  'claude-sonnet-4.6': { name: 'claude-sonnet-4.6', provider: 'anthropic', enumValue: 0, modelUid: 'claude-sonnet-4-6', credit: 4 },
  'claude-sonnet-4.6-thinking': { name: 'claude-sonnet-4.6-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-sonnet-4-6-thinking', credit: 5 },
  'claude-opus-4.6': { name: 'claude-opus-4.6', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-6', credit: 6 },
  'claude-opus-4.6-thinking': { name: 'claude-opus-4.6-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-6-thinking', credit: 8 },
  'claude-opus-4-7-low': { name: 'claude-opus-4-7-low', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-low', credit: 6 },
  'claude-opus-4-7-medium': { name: 'claude-opus-4-7-medium', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-medium', credit: 6 },
  'claude-opus-4-7-high': { name: 'claude-opus-4-7-high', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-high', credit: 6 },
  'claude-opus-4-7-xhigh': { name: 'claude-opus-4-7-xhigh', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-xhigh', credit: 6 },
  'claude-opus-4-7-max': { name: 'claude-opus-4-7-max', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-max', credit: 6 },
  // GPT
  'gpt-4o': { name: 'gpt-4o', provider: 'openai', enumValue: 300, modelUid: null, credit: 2 },
  'gpt-4o-mini': { name: 'gpt-4o-mini', provider: 'openai', enumValue: 301, modelUid: null, credit: 0.5 },
  'gpt-4.1': { name: 'gpt-4.1', provider: 'openai', enumValue: 0, modelUid: 'gpt-4-1', credit: 2 },
  'gpt-4.1-mini': { name: 'gpt-4.1-mini', provider: 'openai', enumValue: 0, modelUid: 'gpt-4-1-mini', credit: 1 },
  'gpt-4.1-nano': { name: 'gpt-4.1-nano', provider: 'openai', enumValue: 0, modelUid: 'gpt-4-1-nano', credit: 0.5 },
  'gpt-5': { name: 'gpt-5', provider: 'openai', enumValue: 0, modelUid: 'gpt-5', credit: 3 },
  'gpt-5-mini': { name: 'gpt-5-mini', provider: 'openai', enumValue: 0, modelUid: 'gpt-5-mini', credit: 1 },
  'o3': { name: 'o3', provider: 'openai', enumValue: 0, modelUid: 'o3', credit: 4 },
  'o3-mini': { name: 'o3-mini', provider: 'openai', enumValue: 0, modelUid: 'o3-mini', credit: 2 },
  'o4-mini': { name: 'o4-mini', provider: 'openai', enumValue: 0, modelUid: 'o4-mini', credit: 2 },
  // Gemini
  'gemini-2.5-pro': { name: 'gemini-2.5-pro', provider: 'google', enumValue: 311, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_PRO', credit: 2 },
  'gemini-2.5-flash': { name: 'gemini-2.5-flash', provider: 'google', enumValue: 312, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', credit: 0.5 },
  'gemini-3.0-pro': { name: 'gemini-3.0-pro', provider: 'google', enumValue: 0, modelUid: 'gemini-3-0-pro', credit: 2 },
  'gemini-3.0-flash': { name: 'gemini-3.0-flash', provider: 'google', enumValue: 0, modelUid: 'gemini-3-0-flash', credit: 0.5 },
  // Others
  'deepseek-v3': { name: 'deepseek-v3', provider: 'deepseek', enumValue: 0, modelUid: 'deepseek-v3', credit: 1 },
  'deepseek-r1': { name: 'deepseek-r1', provider: 'deepseek', enumValue: 0, modelUid: 'deepseek-r1', credit: 2 },
  'grok-3': { name: 'grok-3', provider: 'xai', enumValue: 0, modelUid: 'grok-3', credit: 2 },
  'grok-3-mini': { name: 'grok-3-mini', provider: 'xai', enumValue: 0, modelUid: 'grok-3-mini', credit: 1 },
  'qwen-3': { name: 'qwen-3', provider: 'alibaba', enumValue: 0, modelUid: 'qwen-3', credit: 1 },
  'qwen-3-coder': { name: 'qwen-3-coder', provider: 'alibaba', enumValue: 0, modelUid: 'qwen-3-coder', credit: 1 },
  'kimi-k2': { name: 'kimi-k2', provider: 'moonshot', enumValue: 0, modelUid: 'kimi-k2', credit: 1 },
  'kimi-k2.5': { name: 'kimi-k2.5', provider: 'moonshot', enumValue: 0, modelUid: 'kimi-k2-5', credit: 1 },
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

// Aliases for common names
const ALIASES: Record<string, string> = {
  'gpt-3.5-turbo': 'gpt-4o-mini',
  'gpt-4': 'gpt-4o',
  'gpt-4-turbo': 'gpt-4o',
  'claude-3-5-sonnet': 'claude-sonnet-4.6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4.6',
  'claude-3-5-sonnet-latest': 'claude-sonnet-4.6',
  'claude-sonnet': 'claude-sonnet-4.6',
  'claude-3-opus': 'claude-opus-4.6',
  'claude-3-opus-20240229': 'claude-opus-4.6',
  'claude-opus': 'claude-opus-4.6',
  'claude-3-5-haiku': 'claude-4.5-haiku',
  'claude-haiku': 'claude-4.5-haiku',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-7': 'claude-opus-4-7-medium',
  'claude-opus-4.7': 'claude-opus-4-7-medium',
  'gemini-pro': 'gemini-2.5-pro',
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-2.5-flash',
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
  return id.includes('thinking') || id.includes('opus-4-7');
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
