#!/usr/bin/env node
/**
 * Windsurf API — CLI entrypoint.
 * CLI entrypoint with interactive auth and account management.
 */

import { createInterface } from 'readline';
import { exec } from 'child_process';
import { config, log } from './config.js';
import { startLanguageServer, stopLanguageServer, detectLsBinary } from './core/langserver.js';
import { destroyPool } from './core/grpc.js';
import { startServer } from './server.js';
import { initChannels, addChannel, listChannels, removeChannel, clearAllChannels } from './services/channel.js';
import { initTokens } from './services/token.js';
import { initStats, getStats } from './services/stats.js';
import { loadProxyConfig, setProxy, enableProxy, disableProxy, clearProxy, applyProxy } from './services/proxy.js';

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

// ─── add-account ────────────────────────────────────────

async function cmdAddAccount(flags: Record<string, string>) {
  const token = flags['token'] || flags['t'];
  if (!token) {
    console.error('Usage: windsurf-api add-account --token <session_token> [--label <name>]');
    console.error('');
    console.error('How to get your token:');
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

  console.log('  Step 1: Open Windsurf in your browser and log in\n');

  const autoOpen = flags['no-browser'] !== 'true';
  if (autoOpen) {
    console.log('  Opening https://windsurf.com ...');
    openBrowser('https://windsurf.com');
    console.log('');
  }

  console.log('  Step 2: Get your session token');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  Option A: From browser cookies              │');
  console.log('  │    1. Press F12 to open DevTools             │');
  console.log('  │    2. Go to Application → Cookies            │');
  console.log('  │    3. Find "devin_session_token"             │');
  console.log('  │    4. Copy the value                         │');
  console.log('  │                                              │');
  console.log('  │  Option B: From Windsurf auth page           │');
  console.log('  │    1. Go to windsurf.com account settings    │');
  console.log('  │    2. Copy the auth/session token            │');
  console.log('  └──────────────────────────────────────────────┘\n');

  const token = await prompt('  Paste your token here: ');

  if (!token) {
    console.error('\n  ✗ No token provided. Aborted.\n');
    process.exit(1);
  }

  // Clean up token — strip quotes, whitespace
  const cleanToken = token.replace(/^['"]|['"]$/g, '').trim();

  if (cleanToken.length < 10) {
    console.error('\n  ✗ Token looks too short. Please check and try again.\n');
    process.exit(1);
  }

  const label = await prompt('  Account label (press Enter for auto): ');
  const finalLabel = label || `account-${Date.now().toString(36)}`;

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
  console.log('    --no-browser              Don\'t auto-open browser');
  console.log('');
  console.log('  add-account                 Add account directly with token');
  console.log('    --token, -t <token>       Session token (devin_session_token)');
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
