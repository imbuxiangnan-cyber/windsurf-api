/**
 * Model routing — name mapping, smart matching, concurrency control.
 * Persisted to config.json in data directory.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config, log } from '../config.js';

interface RoutingConfig {
  mapping: Record<string, string>;
  concurrency: Record<string, number>;
}

const DEFAULT: RoutingConfig = { mapping: {}, concurrency: {} };

function configPath(): string {
  return join(config.dataDir, 'config.json');
}

function loadConfig(): RoutingConfig {
  try {
    if (existsSync(configPath())) {
      return { ...DEFAULT, ...JSON.parse(readFileSync(configPath(), 'utf-8')) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT };
}

function saveConfig(cfg: RoutingConfig): void {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// ─── Model name mapping ─────────────────────────────────

export function getMapping(): Record<string, string> {
  return loadConfig().mapping;
}

export function setMapping(mapping: Record<string, string>): void {
  const cfg = loadConfig();
  cfg.mapping = mapping;
  saveConfig(cfg);
  log.info(`Model mapping updated: ${Object.keys(mapping).length} rules`);
}

/**
 * Apply model name mapping.
 * 1. Exact match in mapping table
 * 2. Wildcard (*) mapping
 * 3. Return original name
 */
export function applyMapping(model: string): string {
  const mapping = getMapping();
  if (mapping[model]) return mapping[model];
  if (mapping['*']) return mapping['*'];
  return model;
}

// ─── Smart model name matching ──────────────────────────

/**
 * Normalize model name for fuzzy matching.
 * Handles: date suffixes, dash vs dot versions, old format names.
 */
export function normalizeModelName(name: string): string {
  let n = name.trim().toLowerCase();
  // Strip date suffix: claude-sonnet-4-20250101 → claude-sonnet-4
  n = n.replace(/-\d{8}$/, '');
  return n;
}

/**
 * Smart match: try exact, then normalized, then dash↔dot variants.
 */
export function smartMatchModel(requested: string, availableModels: string[]): string | null {
  // 1. Exact match
  if (availableModels.includes(requested)) return requested;

  const reqNorm = normalizeModelName(requested);

  // 2. Normalized match
  for (const m of availableModels) {
    if (normalizeModelName(m) === reqNorm) return m;
  }

  // 3. Dash ↔ Dot variants: claude-opus-4-5 ↔ claude-opus-4.5
  const dashToDot = reqNorm.replace(/-(\d+)$/, '.$1');
  const dotToDash = reqNorm.replace(/\.(\d+)$/, '-$1');

  for (const m of availableModels) {
    const mNorm = normalizeModelName(m);
    if (mNorm === dashToDot || mNorm === dotToDash) return m;
  }

  // 4. Old Anthropic format: claude-3-5-sonnet → claude-sonnet-3.5
  const oldFormatMatch = reqNorm.match(/^claude-(\d+)-(\d+)-(.+)$/);
  if (oldFormatMatch) {
    const newFormat = `claude-${oldFormatMatch[3]}-${oldFormatMatch[1]}.${oldFormatMatch[2]}`;
    for (const m of availableModels) {
      if (normalizeModelName(m) === newFormat) return m;
    }
  }

  return null;
}

// ─── Concurrency control ────────────────────────────────

const activeRequests: Map<string, number> = new Map();

export function getConcurrencyConfig(): Record<string, number> {
  return loadConfig().concurrency;
}

export function setConcurrencyConfig(concurrency: Record<string, number>): void {
  const cfg = loadConfig();
  cfg.concurrency = concurrency;
  saveConfig(cfg);
  log.info(`Concurrency config updated: ${Object.keys(concurrency).length} rules`);
}

export function getConcurrencyLimit(model: string): number {
  const cfg = getConcurrencyConfig();
  return cfg[model] || cfg['default'] || 0; // 0 = unlimited
}

export function getActiveCount(model: string): number {
  return activeRequests.get(model) || 0;
}

export function acquireConcurrency(model: string): boolean {
  const limit = getConcurrencyLimit(model);
  if (limit <= 0) {
    // Unlimited
    activeRequests.set(model, (activeRequests.get(model) || 0) + 1);
    return true;
  }
  const current = activeRequests.get(model) || 0;
  if (current >= limit) return false;
  activeRequests.set(model, current + 1);
  return true;
}

export function releaseConcurrency(model: string): void {
  const current = activeRequests.get(model) || 0;
  if (current > 0) activeRequests.set(model, current - 1);
}

/**
 * Wait for concurrency slot, with timeout.
 */
export async function waitForConcurrency(model: string, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (!acquireConcurrency(model)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return true;
}
