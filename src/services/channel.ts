/**
 * Channel management — upstream Windsurf account pool.
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

let channels: Channel[] = [];

export function initChannels(): void {
  channels = loadData<Channel[]>(DATA_KEY, []);
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

export function removeChannel(id: string): boolean {
  const idx = channels.findIndex(c => c.id === id);
  if (idx === -1) return false;
  const removed = channels.splice(idx, 1)[0];
  persist();
  log.info(`Removed channel: ${removed.email} (${id})`);
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
  return channels.map(c => ({
    id: c.id,
    email: c.email,
    status: c.status,
    tier: c.tier,
    errorCount: c.errorCount,
    lastUsed: c.lastUsed,
    rpm: pruneRpmHistory(c, now),
    createdAt: c.createdAt,
  }));
}

export function pickChannel(excludeKeys: string[] = []): Channel | null {
  const now = Date.now();
  const candidates = channels.filter(c => {
    if (c.status !== 'active') return false;
    if (c.errorCount >= ERROR_THRESHOLD) return false;
    if (excludeKeys.includes(c.apiKey)) return false;
    const rpm = pruneRpmHistory(c, now);
    return rpm < RPM_LIMIT;
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const rpmA = pruneRpmHistory(a, now);
    const rpmB = pruneRpmHistory(b, now);
    return rpmA - rpmB;
  });

  const chosen = candidates[0];
  chosen.lastUsed = now;
  chosen.rpmHistory.push(now);
  persist();
  return chosen;
}

export function hasActiveChannels(): boolean {
  return channels.some(c => c.status === 'active' && c.errorCount < ERROR_THRESHOLD);
}

export function getChannelCount(): number {
  return channels.length;
}

export function markChannelError(apiKey: string): void {
  const ch = channels.find(c => c.apiKey === apiKey);
  if (!ch) return;
  ch.errorCount++;
  if (ch.errorCount >= ERROR_THRESHOLD) ch.status = 'error';
  persist();
}

export function markChannelSuccess(apiKey: string): void {
  const ch = channels.find(c => c.apiKey === apiKey);
  if (!ch) return;
  ch.errorCount = Math.max(0, ch.errorCount - 1);
  if (ch.status === 'error' && ch.errorCount < RECOVERY_THRESHOLD) ch.status = 'active';
  persist();
}
