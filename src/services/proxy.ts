/**
 * Proxy configuration — persistent proxy settings.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

interface ProxyConfig {
  enabled: boolean;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

const DEFAULT: ProxyConfig = { enabled: false, httpProxy: '', httpsProxy: '', noProxy: '' };

function configPath(): string {
  return join(config.dataDir, 'proxy.json');
}

export function loadProxyConfig(): ProxyConfig {
  try {
    if (existsSync(configPath())) {
      return { ...DEFAULT, ...JSON.parse(readFileSync(configPath(), 'utf-8')) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT };
}

export function saveProxyConfig(cfg: ProxyConfig): void {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function applyProxy(): void {
  const cfg = loadProxyConfig();
  if (!cfg.enabled) return;
  if (cfg.httpProxy) process.env.HTTP_PROXY = cfg.httpProxy;
  if (cfg.httpsProxy) process.env.HTTPS_PROXY = cfg.httpsProxy;
  if (cfg.noProxy) process.env.NO_PROXY = cfg.noProxy;
}

export function setProxy(httpProxy: string, httpsProxy?: string, noProxy?: string): ProxyConfig {
  const cfg: ProxyConfig = {
    enabled: true,
    httpProxy,
    httpsProxy: httpsProxy || httpProxy,
    noProxy: noProxy || '',
  };
  saveProxyConfig(cfg);
  return cfg;
}

export function enableProxy(): ProxyConfig {
  const cfg = loadProxyConfig();
  cfg.enabled = true;
  saveProxyConfig(cfg);
  return cfg;
}

export function disableProxy(): ProxyConfig {
  const cfg = loadProxyConfig();
  cfg.enabled = false;
  saveProxyConfig(cfg);
  return cfg;
}

export function clearProxy(): void {
  saveProxyConfig(DEFAULT);
}
