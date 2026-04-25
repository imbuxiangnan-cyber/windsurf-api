#!/usr/bin/env node
/**
 * Windsurf API — CLI entrypoint.
 * Modeled after copilot-api-plus CLI style.
 */

import { config, log } from './config.js';
import { startLanguageServer, stopLanguageServer, detectLsBinary } from './core/langserver.js';
import { startServer } from './server.js';
import { initChannels, addChannel, listChannels, removeChannel } from './services/channel.js';
import { initTokens } from './services/token.js';
import { initStats, getStats } from './services/stats.js';

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
  let lsPath = flags['ls-path'] || flags['l'] || config.lsBinaryPath;

  if (verbose) config.logLevel = 'debug';

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
    console.log('\n  Claude Code integration:');
    console.log(`    export ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log('    export ANTHROPIC_API_KEY=sk-any');
    console.log('    claude\n');
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
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

// ─── list-accounts ──────────────────────────────────────

function cmdListAccounts() {
  initChannels();
  const channels = listChannels();

  if (channels.length === 0) {
    console.log('\n  No accounts configured.');
    console.log('  Add one with: windsurf-api add-account --email <email> --password <pw>\n');
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

  const detected = detectLsBinary();
  console.log(`  LS auto-detect:  ${detected || 'not found'}`);
  console.log('');
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
  console.log('');
  console.log('  add-account                 Add a Windsurf account');
  console.log('    --token, -t <token>       Session token (devin_session_token)');
  console.log('    --label, -l <label>       Account label');
  console.log('    --tier <tier>             Account tier (default: pro)');
  console.log('');
  console.log('  list-accounts               List all accounts');
  console.log('  remove-account <id>         Remove an account');
  console.log('    --force, -f               Skip confirmation');
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
  console.log('  windsurf-api start');
  console.log('  windsurf-api start --claude-code');
  console.log('  windsurf-api start --port 8080 --ls-path /opt/windsurf/language_server_linux_x64');
  console.log('  windsurf-api add-account --token <your_devin_session_token>');
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
    case 'add-account':
      await cmdAddAccount(flags);
      break;
    case 'list-accounts':
      cmdListAccounts();
      break;
    case 'remove-account':
      cmdRemoveAccount(positional, flags);
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
