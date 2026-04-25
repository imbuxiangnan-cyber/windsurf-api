/**
 * Channel management — upstream Windsurf account pool.
 * Account states: active, rate_limited, exhausted, error, banned, disabled.
 * Selection: filter unavailable → sort by least RPM (round-robin) → pick first.
 */

import { randomUUID } from 'crypto';
import { Channel, ChannelPublic } from '../types.js';
import { loadData, saveData } from './store.js';
import { log } from '../config.js';

const DATA_KEY = 'channels';
const RPM_LIMIT = 60;
const RPM_WINDOW_MS = 60 * 1000;
const ERROR_THRESHOLD = 5;
const RECOVERY_THRESHOLD = 3;
const COOLDOWN_MS = 60 * 1000;

let channels: Channel[] = [];

export function initChannels(): void {
  channels = loadData<Channel[]>(DATA_KEY, []);
  // Auto-recover rate_limited/error channels on startup
  const now = Date.now();
  for (const ch of channels) {
    if ((ch.status === 'rate_limited' || ch.status === 'error') && ch.lastUsed && now - ch.lastUsed > COOLDOWN_MS) {
      ch.status = 'active';
      ch.errorCount = 0;
    }
  }
  persist();
  log.info(`Loaded ${channels.length} channel(s)`);
}

function persist(): void {
  saveData(DATA_KEY, channels);
}

function pruneRpmHistory(ch: Channel, now: number): number {
  const cutoff = now - RPM_WINDOW_MS;
  while (ch.rpmHistory.length && ch.rpmHistory[0] < cutoff) {
    ch.rpmHistory.shift();
  }
  return ch.rpmHistory.length;
}

function tryAutoRecover(ch: Channel, now: number): void {
  if (ch.status === 'rate_limited' && ch.lastUsed && now - ch.lastUsed > COOLDOWN_MS) {
    ch.status = 'active';
    ch.errorCount = 0;
    log.info(`Channel ${ch.id} auto-recovered from rate_limited`);
  }
  if (ch.status === 'error' && ch.lastUsed && now - ch.lastUsed > COOLDOWN_MS) {
    ch.status = 'active';
    ch.errorCount = 0;
    log.info(`Channel ${ch.id} auto-recovered from error`);
  }
}

export function addChannel(email: string, apiKey: string, tier = 'pro'): Channel {
  const existing = channels.find(c => c.apiKey === apiKey);
  if (existing) return existing;

  const ch: Channel = {
    id: randomUUID().slice(0, 8),
    email,
    apiKey,
    status: 'active',
    tier,
    errorCount: 0,
    lastUsed: 0,
    rpmHistory: [],
    createdAt: Date.now(),
  };
  channels.push(ch);
  persist();
  log.info(`Added channel: ${email} (${ch.id})`);
  return ch;
}

export function removeChannel(idOrLabel: string): boolean {
  let idx = channels.findIndex(c => c.id === idOrLabel);
  if (idx === -1) idx = channels.findIndex(c => c.email === idOrLabel);
  // Support numeric index (1-based)
  if (idx === -1) {
    const num = parseInt(idOrLabel, 10);
    if (num >= 1 && num <= channels.length) idx = num - 1;
  }
  if (idx === -1) return false;
  const removed = channels.splice(idx, 1)[0];
  persist();
  log.info(`Removed channel: ${removed.email} (${removed.id})`);
  return true;
}

export function getChannelById(id: string): Channel | null {
  return channels.find(c => c.id === id) || null;
}

export function updateChannelStatus(id: string, status: Channel['status']): boolean {
  const ch = channels.find(c => c.id === id);
  if (!ch) return false;
  ch.status = status;
  if (status === 'active') ch.errorCount = 0;
  persist();
  return true;
}

export function listChannels(): ChannelPublic[] {
  const now = Date.now();
  return channels.map(c => {
    tryAutoRecover(c, now);
    return {
      id: c.id,
      email: c.email,
      status: c.status,
      tier: c.tier,
      errorCount: c.errorCount,
      lastUsed: c.lastUsed,
      rpm: pruneRpmHistory(c, now),
      createdAt: c.createdAt,
    };
  });
}

export function pickChannel(excludeKeys: string[] = []): Channel | null {
  const now = Date.now();

  // Auto-recover channels first
  for (const ch of channels) tryAutoRecover(ch, now);

  const candidates = channels.filter(c => {
    if (c.status !== 'active') return false;
    if (c.errorCount >= ERROR_THRESHOLD) return false;
    if (excludeKeys.includes(c.apiKey)) return false;
    const rpm = pruneRpmHistory(c, now);
    return rpm < RPM_LIMIT;
  });
  if (candidates.length === 0) return null;

  // Sort: least RPM first (round-robin effect), then least recently used
  candidates.sort((a, b) => {
    const rpmA = pruneRpmHistory(a, now);
    const rpmB = pruneRpmHistory(b, now);
    if (rpmA !== rpmB) return rpmA - rpmB;
    return a.lastUsed - b.lastUsed;
  });

  const chosen = candidates[0];
  chosen.lastUsed = now;
  chosen.rpmHistory.push(now);
  persist();
  return chosen;
}

export function hasActiveChannels(): boolean {
  const now = Date.now();
  for (const ch of channels) tryAutoRecover(ch, now);
  return channels.some(c => c.status === 'active' && c.errorCount < ERROR_THRESHOLD);
}

export function getChannelCount(): number {
  return channels.length;
}

export function markChannelError(apiKey: string, reason?: string): void {
  const ch = channels.find(c => c.apiKey === apiKey);
  if (!ch) return;
  ch.errorCount++;
  ch.lastUsed = Date.now();

  if (reason === 'rate_limited') {
    ch.status = 'rate_limited';
    log.warn(`Channel ${ch.id} rate limited, cooling down 60s`);
  } else if (reason === 'exhausted') {
    ch.status = 'exhausted';
    log.warn(`Channel ${ch.id} exhausted`);
  } else if (reason === 'banned' || reason === 'unauthorized') {
    ch.status = 'banned';
    log.error(`Channel ${ch.id} banned/unauthorized, needs manual fix`);
  } else if (ch.errorCount >= ERROR_THRESHOLD) {
    ch.status = 'error';
    log.warn(`Channel ${ch.id} entered error state (${ch.errorCount} errors)`);
  }
  persist();
}

export function markChannelSuccess(apiKey: string): void {
  const ch = channels.find(c => c.apiKey === apiKey);
  if (!ch) return;
  ch.errorCount = Math.max(0, ch.errorCount - 1);
  if ((ch.status === 'error' || ch.status === 'rate_limited') && ch.errorCount < RECOVERY_THRESHOLD) {
    ch.status = 'active';
  }
  persist();
}

export function clearAllChannels(): void {
  channels = [];
  persist();
}
