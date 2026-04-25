/**
 * Simple JSON file persistence layer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { config, log } from '../config.js';

function getDataDir(): string {
  return config.dataDir;
}

function dataPath(key: string): string {
  return `${getDataDir()}/${key}.json`;
}

function ensureDir(): void {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadData<T>(key: string, fallback: T): T {
  ensureDir();
  const path = dataPath(key);
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    log.warn(`Failed to load ${key}:`, e.message);
    return fallback;
  }
}

export function saveData<T>(key: string, data: T): void {
  ensureDir();
  const path = dataPath(key);
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e: any) {
    log.error(`Failed to save ${key}:`, e.message);
  }
}
