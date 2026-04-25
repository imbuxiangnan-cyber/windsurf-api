/**
 * API Key management — downstream consumer tokens.
 */

import { randomUUID, randomBytes } from 'crypto';
import { ApiToken } from '../types.js';
import { loadData, saveData } from './store.js';
import { config, log } from '../config.js';

const DATA_KEY = 'tokens';
let tokens: ApiToken[] = [];

export function initTokens(): void {
  tokens = loadData<ApiToken[]>(DATA_KEY, []);
  log.info(`Loaded ${tokens.length} API token(s)`);
}

function persist(): void {
  saveData(DATA_KEY, tokens);
}

function generateKey(): string {
  return 'sk-ws-' + randomBytes(16).toString('hex');
}

export function createToken(name: string, totalQuota = 0, allowedModels: string[] = []): ApiToken {
  const token: ApiToken = {
    id: randomUUID().slice(0, 8),
    key: generateKey(),
    name: name || 'default',
    status: 'active',
    createdAt: Date.now(),
    usedQuota: 0,
    totalQuota,
    allowedModels: allowedModels || [],
    reqCount: 0,
  };
  tokens.push(token);
  persist();
  return token;
}

export function removeToken(id: string): boolean {
  const idx = tokens.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tokens.splice(idx, 1);
  persist();
  return true;
}

export function listTokens(): ApiToken[] {
  return tokens.map(t => ({ ...t }));
}

export function validateToken(key: string): { valid: boolean; token?: ApiToken; error?: string } {
  // If global API_KEY is set, check it first
  if (config.apiKey && key === config.apiKey) {
    return { valid: true };
  }

  // If no tokens exist and no global API_KEY, allow all
  if (tokens.length === 0 && !config.apiKey) {
    return { valid: true };
  }

  const token = tokens.find(t => t.key === key);
  if (!token) return { valid: false, error: 'Invalid API key' };
  if (token.status !== 'active') return { valid: false, error: 'API key disabled' };
  if (token.totalQuota > 0 && token.usedQuota >= token.totalQuota) {
    return { valid: false, error: 'Quota exceeded' };
  }
  return { valid: true, token };
}

export function isModelAllowedForToken(token: ApiToken, modelKey: string): boolean {
  if (!token.allowedModels || token.allowedModels.length === 0) return true;
  return token.allowedModels.includes(modelKey);
}

export function consumeQuota(key: string, tokensUsed: number): void {
  const t = tokens.find(tk => tk.key === key);
  if (!t) return;
  t.usedQuota += tokensUsed;
  t.reqCount++;
  persist();
}
