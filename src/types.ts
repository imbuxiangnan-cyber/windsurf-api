/**
 * Shared type definitions.
 */

export interface Channel {
  id: string;
  email: string;
  apiKey: string;
  status: 'active' | 'rate_limited' | 'exhausted' | 'error' | 'banned' | 'disabled';
  tier: string;
  errorCount: number;
  lastUsed: number;
  rpmHistory: number[];
  createdAt: number;
}

export interface ChannelPublic {
  id: string;
  email: string;
  status: 'active' | 'rate_limited' | 'exhausted' | 'error' | 'banned' | 'disabled';
  tier: string;
  errorCount: number;
  lastUsed: number;
  rpm: number;
  createdAt: number;
}

export interface ApiToken {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: number;
  usedQuota: number;
  totalQuota: number;
  allowedModels: string[];
  reqCount: number;
}

export interface DailyStats {
  date: string;
  requests: number;
  tokens: number;
  byModel: Record<string, number>;
  byChannel: Record<string, number>;
  tokensByModel?: Record<string, number>;
  byApiKey?: Record<string, { requests: number; tokens: number }>;
}

export interface Stats {
  totalRequests: number;
  totalTokens: number;
  daily: DailyStats[];
  lastUpdated: number;
}

export interface ModelInfo {
  name: string;
  provider: string;
  enumValue: number;
  modelUid: string | null;
  credit: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}
