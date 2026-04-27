#!/usr/bin/env node
/**
 * Windsurf API — CLI entrypoint.
 * CLI entrypoint with interactive auth and account management.
 */

import { createInterface } from 'readline';
import { exec, execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import https from 'https';
import { config, log } from './config.js';
import { startLanguageServer, stopLanguageServer, detectLsBinary } from './core/langserver.js';
import { destroyPool } from './core/grpc.js';
import { startServer } from './server.js';
import { initChannels, addChannel, listChannels, removeChannel, clearAllChannels } from './services/channel.js';
import { initTokens } from './services/token.js';
import { initStats, getStats } from './services/stats.js';
import { loadProxyConfig, setProxy, enableProxy, disableProxy, clearProxy, applyProxy } from './services/proxy.js';
import { windsurfLogin, windsurfOttLogin } from './core/login.js';

const BANNER = `
╦ ╦┬┌┐┌┌┬┐┌─┐┬ ┬┬─┐┌─┐  ╔═╗╔═╗╦
║║║││││ ││└─┐│ │├┬┘├┤   ╠═╣╠═╝║
╚╩╝┴┘└┘─┴┘└─┘└─┘┴└─└    ╩ ╩╩  ╩

Windsurf → OpenAI / Anthropic API Proxy
`;

function parseArgs(args: string[]): { command: string; flags: Record<string, string>; positional: string[] } {
  const command = args[0] || 'start';
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

// ─── start ──────────────────────────────────────────────

async function cmdStart(flags: Record<string, string>) {
  console.log(BANNER);

  const port = parseInt(flags['port'] || flags['p'] || String(config.port), 10);
  const verbose = flags['verbose'] === 'true' || flags['v'] === 'true';
  const claudeCode = flags['claude-code'] === 'true' || flags['c'] === 'true';
  const proxyEnv = flags['proxy-env'] === 'true';
  let lsPath = flags['ls-path'] || flags['l'] || config.lsBinaryPath;

  if (verbose) config.logLevel = 'debug';
  if (flags['api-key']) config.apiKey = flags['api-key'];
  if (flags['rate-limit']) (config as any).rateLimit = parseFloat(flags['rate-limit']);
  if (flags['wait'] === 'true' || flags['w'] === 'true') (config as any).waitOnLimit = true;

  // Apply proxy
  if (proxyEnv) {
    log.info('Using proxy from environment variables');
  } else {
    applyProxy();
    const pcfg = loadProxyConfig();
    if (pcfg.enabled && pcfg.httpProxy) {
      log.info(`Proxy: ${pcfg.httpProxy}`);
    }
  }

  initChannels();

  // Auto-extract token from desktop app if no accounts exist
  const channels = listChannels();
  if (channels.length === 0) {
    const desktopToken = extractDesktopToken();
    if (desktopToken) {
      addChannel(`desktop-${Date.now().toString(36)}`, desktopToken, 'pro');
      log.info('Auto-extracted token from Windsurf desktop app');
    }
  } else {
    // Refresh token from desktop app if available (only for auto-added single account)
    const desktopToken = extractDesktopToken();
    if (desktopToken && channels.length === 1 && channels[0].email?.startsWith('desktop-')) {
      removeChannel(channels[0].id);
      addChannel(`desktop-${Date.now().toString(36)}`, desktopToken, 'pro');
      log.info('Refreshed token from Windsurf desktop app');
    }
  }

  initTokens();
  initStats();

  log.info(`Data directory: ${config.dataDir}`);

  // Auto-detect LS binary
  if (!lsPath) {
    lsPath = detectLsBinary() || '';
  }

  if (!lsPath) {
    log.warn('Language Server binary not found!');
    log.warn('Set LS_BINARY_PATH env or use --ls-path flag.');
    log.warn('Get it from your Windsurf desktop app:');
    log.warn('  Windows: %APPDATA%\\Windsurf\\bin\\language_server_windows_x64.exe');
    log.warn('  macOS:   ~/Library/Application Support/Windsurf/.../language_server_macos_arm');
    log.warn('  Linux:   ~/.windsurf/bin/language_server_linux_x64');
    log.warn('Server will start but API calls will fail.');
  } else {
    try {
      await startLanguageServer({
        binaryPath: lsPath,
        port: config.lsPort,
        apiServerUrl: config.apiServerUrl,
      });
    } catch (err: any) {
      log.error('Language server failed to start:', err.message);
      log.error('API calls will not work.');
    }
  }

  const server = startServer(port);

  // Claude Code integration hint
  if (claudeCode) {
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │  Claude Code Integration                     │');
    console.log('  ├──────────────────────────────────────────────┤');
    console.log('  │  Option A: Environment variables             │');
    console.log(`  │    export ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log('  │    export ANTHROPIC_API_KEY=sk-any           │');
    console.log('  │    claude                                    │');
    console.log('  │                                              │');
    console.log('  │  Option B: .claude/settings.json             │');
    console.log('  │    {                                         │');
    console.log('  │      "env": {                                │');
    console.log(`  │        "ANTHROPIC_BASE_URL": "http://localhost:${port}",`);
    console.log('  │        "ANTHROPIC_AUTH_TOKEN": "dummy",      │');
    console.log('  │        "ANTHROPIC_MODEL": "claude-sonnet-4", │');
    console.log('  │        "API_TIMEOUT_MS": "3000000"           │');
    console.log('  │      }                                       │');
    console.log('  │    }                                         │');
    console.log('  └──────────────────────────────────────────────┘\n');
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
    destroyPool();
    server.close(() => {
      stopLanguageServer();
      process.exit(0);
    });
    setTimeout(() => {
      stopLanguageServer();
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ─── auto-extract token from desktop app ─────────────────

function extractDesktopToken(): string | null {
  try {
    const appData = process.env.APPDATA || '';
    const vscdb = join(appData, 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
    if (!existsSync(vscdb)) return null;
    const buf = readFileSync(vscdb);
    const str = buf.toString('utf-8');
    const match = str.match(/apiKey":"(devin-session-token\$[^"]+)"/);
    return match ? match[1] : null;
  } catch { return null; }
}

// ─── add-account ────────────────────────────────────────

async function cmdAddAccount(flags: Record<string, string>) {
  let token = flags['token'] || flags['t'];
  if (!token && flags['auto'] !== undefined) {
    token = extractDesktopToken() || '';
    if (token) console.log('  ✓ Auto-extracted token from Windsurf desktop app');
  }
  if (!token) {
    console.error('Usage: windsurf-api add-account --token <session_token> [--label <name>]');
    console.error('       windsurf-api add-account --auto   (extract from desktop app)');
    console.error('');
    console.error('How to get your token manually:');
    console.error('  1. Open Windsurf desktop app');
    console.error('  2. Open DevTools (F12)');
    console.error('  3. Application → Cookies → find "devin_session_token"');
    console.error('  4. Copy the token value');
    process.exit(1);
  }

  initChannels();

  const label = flags['label'] || flags['l'] || `account-${Date.now().toString(36)}`;
  const ch = addChannel(label, token, flags['tier'] || 'pro');
  console.log(`\n  ✓ Account added: ${ch.email} (${ch.id})\n`);
}

// ─── auth ───────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function cmdAuth(flags: Record<string, string>) {
  console.log(BANNER);
  console.log('  Windsurf Account Authentication');
  console.log('  ─────────────────────────────────────\n');

  let cleanToken = '';
  let finalLabel = '';

  // Try auto-extract first
  const desktopToken = extractDesktopToken();

  console.log('  Choose login method:\n');
  if (desktopToken) {
    console.log('  [1] Auto — from Windsurf desktop app (detected!)');
  }
  console.log('  [2] OTT — paste one-time token from windsurf.com');
  console.log('  [3] Email + Password — login via Windsurf API');
  console.log('  [4] Token — paste session token manually\n');

  const defaultChoice = desktopToken ? '1' : '2';
  const choice = await prompt(`  Select (${defaultChoice}): `) || defaultChoice;

  if (choice === '1' && desktopToken) {
    cleanToken = desktopToken;
    finalLabel = `desktop-${Date.now().toString(36)}`;
    console.log('\n  ✓ Using token from Windsurf desktop app\n');

  } else if (choice === '2') {
    console.log('');
    console.log('  Get your OTT from: https://windsurf.com/account/tokens');
    console.log('  (Format: ott$...)\n');
    const ott = await prompt('  Paste OTT here: ');
    if (!ott) { console.error('\n  ✗ No token provided. Aborted.\n'); process.exit(1); }

    const cleanOtt = ott.replace(/^['"]|['"]$/g, '').trim();
    console.log('\n  Exchanging OTT for session token...');
    try {
      const result = await windsurfOttLogin(cleanOtt);
      cleanToken = result.sessionToken;
      finalLabel = `ott-${Date.now().toString(36)}`;
      console.log(`  ✓ OTT login successful!\n`);
    } catch (err: any) {
      console.error(`\n  ✗ OTT exchange failed: ${err.message}\n`);
      process.exit(1);
    }

  } else if (choice === '3') {
    console.log('');
    const email = await prompt('  Email: ');
    if (!email) { console.error('\n  ✗ No email provided. Aborted.\n'); process.exit(1); }

    const password = await prompt('  Password: ');
    if (!password) { console.error('\n  ✗ No password provided. Aborted.\n'); process.exit(1); }

    console.log('\n  Logging in...');
    try {
      const result = await windsurfLogin(email, password);
      cleanToken = result.sessionToken;
      finalLabel = email.split('@')[0] || `login-${Date.now().toString(36)}`;
      console.log(`  ✓ Login successful!\n`);
    } catch (err: any) {
      console.error(`\n  ✗ Login failed: ${err.message}\n`);
      process.exit(1);
    }

  } else {
    console.log('');
    console.log('  How to get your session token:');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  1. Open https://windsurf.com and log in     │');
    console.log('  │  2. Press F12 → Application → Cookies        │');
    console.log('  │  3. Find "devin_session_token"               │');
    console.log('  │  4. Copy the value                           │');
    console.log('  └──────────────────────────────────────────────┘\n');

    const token = await prompt('  Paste your token here: ');
    if (!token) { console.error('\n  ✗ No token provided. Aborted.\n'); process.exit(1); }

    cleanToken = token.replace(/^['"]|['"]$/g, '').trim();
    if (cleanToken.length < 10) {
      console.error('\n  ✗ Token looks too short. Please check and try again.\n');
      process.exit(1);
    }

    const label = await prompt('  Account label (press Enter for auto): ');
    finalLabel = label || `account-${Date.now().toString(36)}`;
  }

  initChannels();
  const ch = addChannel(finalLabel, cleanToken, flags['tier'] || 'pro');

  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log(`  │  ✓ Account added successfully!               │`);
  console.log(`  │                                              │`);
  console.log(`  │  Label:  ${finalLabel.padEnd(37)}│`);
  console.log(`  │  ID:     ${ch.id.padEnd(37)}│`);
  console.log(`  │  Status: active                              │`);
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  Next: run `windsurf-api start` to start the server');
  console.log('');
}

// ─── list-accounts ──────────────────────────────────────

function cmdListAccounts() {
  initChannels();
  const channels = listChannels();

  if (channels.length === 0) {
    console.log('\n  No accounts configured.');
    console.log('  Add one with: windsurf-api auth\n');
    return;
  }

  console.log('');
  console.log('  ┌───┬──────────┬──────────────────────────────┬──────────┬────────┬─────┐');
  console.log('  │ # │ ID       │ Email                        │ Status   │ Tier   │ RPM │');
  console.log('  ├───┼──────────┼──────────────────────────────┼──────────┼────────┼─────┤');
  channels.forEach((ch, i) => {
    const num = String(i + 1).padEnd(1);
    const id = ch.id.padEnd(8);
    const email = ch.email.slice(0, 28).padEnd(28);
    const status = ch.status.padEnd(8);
    const tier = ch.tier.padEnd(6);
    const rpm = String(ch.rpm).padEnd(3);
    console.log(`  │ ${num} │ ${id} │ ${email} │ ${status} │ ${tier} │ ${rpm} │`);
  });
  console.log('  └───┴──────────┴──────────────────────────────┴──────────┴────────┴─────┘');
  console.log(`  Total: ${channels.length} account(s)\n`);
}

// ─── remove-account ─────────────────────────────────────

function cmdRemoveAccount(positional: string[], flags: Record<string, string>) {
  const id = positional[0] || flags['id'];
  if (!id) {
    console.error('Usage: windsurf-api remove-account <id>');
    process.exit(1);
  }

  initChannels();
  const force = flags['force'] === 'true' || flags['f'] === 'true';

  if (!force) {
    console.log(`Removing account ${id}... (use --force to skip confirmation)`);
  }

  const ok = removeChannel(id);
  if (ok) {
    console.log(`\n  ✓ Account ${id} removed.\n`);
  } else {
    console.error(`\n  ✗ Account ${id} not found.\n`);
    process.exit(1);
  }
}

// ─── check-usage ────────────────────────────────────────

function cmdCheckUsage() {
  initChannels();
  initStats();

  const channels = listChannels();
  const stats = getStats();

  console.log('');
  console.log('  Usage Summary');
  console.log('  ─────────────────────────────────');
  console.log(`  Total requests:  ${stats.totalRequests}`);
  console.log(`  Total tokens:    ${stats.totalTokens}`);
  console.log(`  Active accounts: ${channels.filter(c => c.status === 'active').length}/${channels.length}`);
  console.log(`  Data directory:  ${config.dataDir}`);
  console.log('');

  if (stats.daily.length > 0) {
    console.log('  Recent activity:');
    console.log('  ┌────────────┬──────────┬────────┐');
    console.log('  │ Date       │ Requests │ Tokens │');
    console.log('  ├────────────┼──────────┼────────┤');
    for (const d of stats.daily.slice(-7).reverse()) {
      console.log(`  │ ${d.date} │ ${String(d.requests).padEnd(8)} │ ${String(d.tokens).padEnd(6)} │`);
    }
    console.log('  └────────────┴──────────┴────────┘');
    console.log('');
  }
}

// ─── debug ──────────────────────────────────────────────

function cmdDebug() {
  initChannels();
  initTokens();
  initStats();

  const channels = listChannels();
  const stats = getStats();

  console.log('');
  console.log('  Windsurf API Debug Info');
  console.log('  ──────────────────────────────────────');
  console.log(`  Node.js:         ${process.version}`);
  console.log(`  Platform:        ${process.platform} ${process.arch}`);
  console.log(`  Data directory:  ${config.dataDir}`);
  console.log(`  Port:            ${config.port}`);
  console.log(`  LS binary:       ${config.lsBinaryPath || '(auto-detect)'}`);
  console.log(`  LS port:         ${config.lsPort}`);
  console.log(`  API server:      ${config.apiServerUrl}`);
  console.log(`  Default model:   ${config.defaultModel}`);
  console.log(`  Log level:       ${config.logLevel}`);
  console.log(`  API key set:     ${config.apiKey ? 'yes' : 'no'}`);
  console.log(`  Dashboard pw:    ${config.dashboardPassword ? 'yes' : 'no'}`);
  console.log(`  Accounts:        ${channels.length}`);
  console.log(`  Total requests:  ${stats.totalRequests}`);

  const pcfg = loadProxyConfig();
  console.log(`  Proxy enabled:   ${pcfg.enabled ? 'yes' : 'no'}`);
  if (pcfg.enabled) {
    console.log(`  HTTP proxy:      ${pcfg.httpProxy || '(not set)'}`);
    console.log(`  HTTPS proxy:     ${pcfg.httpsProxy || '(not set)'}`);
  }

  const detected = detectLsBinary();
  console.log(`  LS auto-detect:  ${detected || 'not found'}`);
  console.log('');
}

// ─── proxy ──────────────────────────────────────────────

async function cmdProxy(flags: Record<string, string>) {
  if (flags['set'] === 'true') {
    const httpProxy = await prompt('  HTTP proxy URL (e.g. http://127.0.0.1:7890): ');
    if (!httpProxy) { console.log('  Cancelled.'); return; }
    const httpsProxy = await prompt('  HTTPS proxy URL (press Enter to use same): ');
    const noProxy = await prompt('  No proxy hosts (press Enter to skip): ');
    const cfg = setProxy(httpProxy, httpsProxy || undefined, noProxy || undefined);
    console.log(`\n  ✓ Proxy configured and enabled`);
    console.log(`    HTTP:  ${cfg.httpProxy}`);
    console.log(`    HTTPS: ${cfg.httpsProxy}\n`);
    return;
  }

  if (flags['http-proxy']) {
    const cfg = setProxy(flags['http-proxy'], flags['https-proxy'] || undefined, flags['no-proxy'] || undefined);
    console.log(`\n  ✓ Proxy configured: ${cfg.httpProxy}\n`);
    return;
  }

  if (flags['enable'] === 'true') {
    enableProxy();
    console.log('\n  ✓ Proxy enabled\n');
    return;
  }

  if (flags['disable'] === 'true') {
    disableProxy();
    console.log('\n  ✓ Proxy disabled (settings preserved)\n');
    return;
  }

  if (flags['clear'] === 'true') {
    clearProxy();
    console.log('\n  ✓ Proxy configuration cleared\n');
    return;
  }

  // Default: show current config
  const cfg = loadProxyConfig();
  console.log('');
  console.log('  Proxy Configuration');
  console.log('  ─────────────────────────────────');
  console.log(`  Status:      ${cfg.enabled ? '✓ Enabled' : '✗ Disabled'}`);
  console.log(`  HTTP proxy:  ${cfg.httpProxy || '(not set)'}`);
  console.log(`  HTTPS proxy: ${cfg.httpsProxy || '(not set)'}`);
  console.log(`  No proxy:    ${cfg.noProxy || '(not set)'}`);
  console.log('');
}

// ─── logout ─────────────────────────────────────────────

async function cmdLogout(flags: Record<string, string>) {
  const all = flags['all'] === 'true' || flags['a'] === 'true';

  if (all) {
    initChannels();
    clearAllChannels();
    clearProxy();
    console.log('\n  ✓ All credentials and proxy settings cleared.\n');
    return;
  }

  initChannels();
  const channels = listChannels();
  if (channels.length === 0) {
    console.log('\n  No accounts to clear.\n');
    return;
  }

  const confirm = await prompt(`  Remove all ${channels.length} account(s)? (y/N): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('  Cancelled.');
    return;
  }

  clearAllChannels();
  console.log(`\n  ✓ ${channels.length} account(s) removed.\n`);
}

// ─── setup (download LS binary) ─────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, redirects = 0): void => {
      if (redirects > 10) { reject(new Error('Too many redirects')); return; }
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'windsurf-api' } }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

const WINDSURF_DOWNLOAD_URLS: Record<string, Record<string, string>> = {
  win32: {
    x64: 'https://windsurf-stable.codeiumdata.com/wVxQEIHkBsUPfSPOLiMFNmPG7Ho=/Windsurf-windows-x64-latest.exe',
  },
  linux: {
    x64: 'https://windsurf-stable.codeiumdata.com/linux-x64/stable/latest',
  },
  darwin: {
    arm64: 'https://windsurf-stable.codeiumdata.com/darwin-arm64/stable/latest',
    x64: 'https://windsurf-stable.codeiumdata.com/darwin-x64/stable/latest',
  },
};

async function cmdSetup() {
  console.log(BANNER);
  console.log('  Windsurf API Setup');
  console.log('  ─────────────────────────────────────\n');

  // Check if LS already exists
  const existing = detectLsBinary();
  if (existing) {
    console.log(`  ✓ LS binary already found: ${existing}\n`);
    console.log('  No setup needed. Run: windsurf-api start\n');
    return;
  }

  const binDir = join(config.dataDir, 'bin');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const platform = process.platform;
  const arch = process.arch;

  let lsBinaryName = '';
  if (platform === 'win32') lsBinaryName = 'language_server_windows_x64.exe';
  else if (platform === 'darwin') lsBinaryName = arch === 'arm64' ? 'language_server_macos_arm' : 'language_server_macos_x64';
  else lsBinaryName = 'language_server_linux_x64';

  const lsDest = join(binDir, lsBinaryName);

  if (existsSync(lsDest)) {
    console.log(`  ✓ LS binary already exists: ${lsDest}\n`);
    return;
  }

  console.log('  The Language Server binary is required to proxy API calls.');
  console.log('  It is included in the Windsurf desktop app.\n');
  console.log('  Options:\n');
  console.log('  [1] Auto-download from Windsurf (may not work if URLs change)');
  console.log('  [2] I\'ll download Windsurf desktop app manually\n');

  const choice = await prompt('  Select (1): ') || '1';

  if (choice === '1') {
    console.log('\n  Downloading Windsurf package...');
    console.log('  This may take a few minutes.\n');

    try {
      // Try direct CDN download
      const urls = WINDSURF_DOWNLOAD_URLS[platform];
      const url = urls?.[arch] || urls?.['x64'];

      if (!url) {
        throw new Error(`No download URL for ${platform}/${arch}`);
      }

      const tmpFile = join(binDir, `windsurf-download-${Date.now()}.tmp`);

      console.log(`  Downloading from CDN...`);
      try {
        await downloadFile(url, tmpFile);
        console.log('  Download complete. Extracting LS binary...');

        // For Windows exe, we can try 7z extraction
        if (platform === 'win32') {
          try {
            // Try using 7z if available
            execSync(`7z e "${tmpFile}" -o"${binDir}" "resources/app/extensions/windsurf/bin/${lsBinaryName}" -y`, { timeout: 60000 });
            console.log(`\n  ✓ LS binary extracted: ${lsDest}\n`);
          } catch {
            // Try using PowerShell Expand-Archive (won't work for exe, but try)
            throw new Error('Auto-extraction not available. Please use option 2.');
          }
        } else {
          // For Linux/Mac tar.gz
          try {
            execSync(`tar xf "${tmpFile}" -C "${binDir}" --strip-components=5 "*/extensions/windsurf/bin/${lsBinaryName}" 2>/dev/null || tar xf "${tmpFile}" -C "${binDir}" --wildcards "*/${lsBinaryName}"`, { timeout: 60000 });
            chmodSync(lsDest, 0o755);
            console.log(`\n  ✓ LS binary extracted: ${lsDest}\n`);
          } catch {
            throw new Error('Auto-extraction failed. Please use option 2.');
          }
        }

        // Cleanup
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

      } catch (dlErr: any) {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        throw dlErr;
      }

    } catch (err: any) {
      console.error(`\n  ✗ Auto-download failed: ${err.message}\n`);
      showManualSetup(lsDest);
      return;
    }

  } else {
    showManualSetup(lsDest);
    return;
  }

  console.log('  Next steps:');
  console.log('    1. windsurf-api auth        (login)');
  console.log('    2. windsurf-api start       (start server)\n');
}

function showManualSetup(targetPath: string) {
  const platform = process.platform;
  console.log('  Manual Setup:');
  console.log('  ─────────────\n');
  console.log('  1. Download Windsurf from: https://windsurf.com/download\n');

  if (platform === 'win32') {
    console.log('  2. Install Windsurf or extract the installer');
    console.log('  3. Copy the LS binary from:');
    console.log('     <Windsurf>\\resources\\app\\extensions\\windsurf\\bin\\language_server_windows_x64.exe');
  } else if (platform === 'darwin') {
    console.log('  2. Mount the DMG and copy Windsurf.app');
    console.log('  3. Copy the LS binary from:');
    console.log('     Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_*');
  } else {
    console.log('  2. Extract the tar.gz');
    console.log('  3. Copy the LS binary from:');
    console.log('     Windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64');
  }

  console.log(`\n  4. Copy it to: ${targetPath}`);
  console.log(`\n  Or use --ls-path flag:`);
  console.log(`     windsurf-api start --ls-path /path/to/language_server\n`);
}

// ─── help ───────────────────────────────────────────────

function showHelp() {
  console.log(BANNER);
  console.log('Commands:');
  console.log('  start                       Start the API server');
  console.log('    --port, -p <port>         Server port (default: 4000)');
  console.log('    --ls-path, -l <path>      Language Server binary path');
  console.log('    --claude-code, -c         Show Claude Code integration hints');
  console.log('    --verbose, -v             Enable debug logging');
  console.log('    --api-key <key>           API key for authentication');
  console.log('    --rate-limit <sec>        Request interval in seconds');
  console.log('    --wait, -w               Wait on rate limit instead of error');
  console.log('    --proxy-env              Use proxy from env vars');
  console.log('');
  console.log('  auth                        Interactive login (recommended)');
  console.log('                              Supports: auto-detect / email+password / token');
  console.log('');
  console.log('  add-account                 Add account directly');
  console.log('    --token, -t <token>       Session token');
  console.log('    --auto                    Auto-extract from Windsurf desktop app');
  console.log('    --label, -l <label>       Account label');
  console.log('    --tier <tier>             Account tier (default: pro)');
  console.log('');
  console.log('  list-accounts               List all accounts');
  console.log('  remove-account <id>         Remove an account (by id/label/number)');
  console.log('    --force, -f               Skip confirmation');
  console.log('');
  console.log('  proxy                       Show proxy configuration');
  console.log('    --set                     Interactive proxy setup');
  console.log('    --http-proxy <url>        Set HTTP proxy');
  console.log('    --https-proxy <url>       Set HTTPS proxy');
  console.log('    --enable                  Enable saved proxy');
  console.log('    --disable                 Disable proxy (keep settings)');
  console.log('    --clear                   Clear proxy configuration');
  console.log('');
  console.log('  logout                      Clear saved credentials');
  console.log('    --all, -a                 Clear all data including proxy');
  console.log('');
  console.log('  setup                       Download Language Server binary');
  console.log('  check-usage                 Show usage statistics');
  console.log('  debug                       Show debug info');
  console.log('  help                        Show this help');
  console.log('');
  console.log('Environment:');
  console.log('  PORT, API_KEY, DASHBOARD_PASSWORD, LS_BINARY_PATH,');
  console.log('  LS_PORT, API_SERVER_URL, DEFAULT_MODEL, LOG_LEVEL, DATA_DIR');
  console.log('');
  console.log('Examples:');
  console.log('  windsurf-api auth');
  console.log('  windsurf-api start');
  console.log('  windsurf-api start --claude-code');
  console.log('  windsurf-api start --api-key my-secret-key');
  console.log('  windsurf-api proxy --http-proxy http://127.0.0.1:7890');
  console.log('  windsurf-api add-account --token <token> --label my-pro-account');
  console.log('  windsurf-api list-accounts');
  console.log('  windsurf-api check-usage');
  console.log('');
}

// ─── main ───────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const { command, flags, positional } = parseArgs(args);

  switch (command) {
    case 'start':
      await cmdStart(flags);
      break;
    case 'auth':
    case 'login':
      await cmdAuth(flags);
      break;
    case 'add-account':
      await cmdAddAccount(flags);
      break;
    case 'list-accounts':
      cmdListAccounts();
      break;
    case 'remove-account':
      cmdRemoveAccount(positional, flags);
      break;
    case 'proxy':
      await cmdProxy(flags);
      break;
    case 'logout':
      await cmdLogout(flags);
      break;
    case 'setup':
    case 'install':
      await cmdSetup();
      break;
    case 'check-usage':
      cmdCheckUsage();
      break;
    case 'debug':
      cmdDebug();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
