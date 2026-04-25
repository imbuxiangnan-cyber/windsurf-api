/**
 * Usage statistics tracking.
 */

import { Stats, DailyStats } from '../types.js';
import { loadData, saveData } from './store.js';
import { log } from '../config.js';

const DATA_KEY = 'stats';
let stats: Stats;

export function initStats(): void {
  stats = loadData<Stats>(DATA_KEY, {
    totalRequests: 0,
    totalTokens: 0,
    daily: [],
    lastUpdated: Date.now(),
  });
  log.info(`Stats loaded: ${stats.totalRequests} total requests`);
}

function persist(): void {
  saveData(DATA_KEY, stats);
}

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getOrCreateDaily(date: string): DailyStats {
  let d = stats.daily.find(x => x.date === date);
  if (!d) {
    d = { date, requests: 0, tokens: 0, byModel: {}, byChannel: {} };
    stats.daily.push(d);
    if (stats.daily.length > 30) stats.daily = stats.daily.slice(-30);
  }
  return d;
}

export function recordRequest(opts: {
  model: string;
  channelId: string;
  tokensUsed: number;
}): void {
  const daily = getOrCreateDaily(getTodayStr());
  stats.totalRequests++;
  stats.totalTokens += opts.tokensUsed;
  daily.requests++;
  daily.tokens += opts.tokensUsed;
  daily.byModel[opts.model] = (daily.byModel[opts.model] || 0) + 1;
  daily.byChannel[opts.channelId] = (daily.byChannel[opts.channelId] || 0) + 1;
  stats.lastUpdated = Date.now();
  persist();
}

export function getStats(): Stats {
  return { ...stats, daily: stats.daily.map(d => ({ ...d })) };
}

export function getTodayStats(): DailyStats {
  return getOrCreateDaily(getTodayStr());
}
