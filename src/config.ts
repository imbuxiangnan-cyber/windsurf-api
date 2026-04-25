/**
 * Global config and logger.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

// Data directory: ~/.windsurf-api/ (like copilot-api-plus uses ~/.local/share/)
function getDefaultDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'windsurf-api');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'windsurf-api');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'windsurf-api');
}

// Load .env file if exists (check cwd and data dir)
function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(getDefaultDataDir(), '.env'),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch { /* ignore */ }
  }
}

loadDotEnv();

const dataDir = process.env.DATA_DIR || getDefaultDataDir();
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  apiKey: process.env.API_KEY || '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  lsBinaryPath: process.env.LS_BINARY_PATH || '',
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),
  apiServerUrl: process.env.API_SERVER_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-sonnet-4.6',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  dataDir,
  verbose: false,
};

const LOG_LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: string): boolean {
  return (LOG_LEVELS[level] || 0) >= (LOG_LEVELS[config.logLevel] || 0);
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export const log = {
  debug: (...args: any[]) => { if (shouldLog('debug')) console.log(`[${ts()}] [DEBUG]`, ...args); },
  info: (...args: any[]) => { if (shouldLog('info')) console.log(`[${ts()}] [INFO]`, ...args); },
  warn: (...args: any[]) => { if (shouldLog('warn')) console.warn(`[${ts()}] [WARN]`, ...args); },
  error: (...args: any[]) => { if (shouldLog('error')) console.error(`[${ts()}] [ERROR]`, ...args); },
};
