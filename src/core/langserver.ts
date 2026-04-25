/**
 * Language server process manager.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import http2 from 'http2';
import { config, log } from '../config.js';

const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-token';

let _process: ReturnType<typeof spawn> | null = null;
let _port = DEFAULT_PORT;
let _csrfToken = DEFAULT_CSRF;
let _ready = false;
let _usingDesktopLs = false;

function getWinSearchPaths(): string[] {
  const paths: string[] = [];
  const lsBin = 'resources\\app\\extensions\\windsurf\\bin\\language_server_windows_x64.exe';
  // Try to find Windsurf.exe via PATH and derive LS path
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(';')) {
    if (dir.toLowerCase().includes('windsurf') && existsSync(`${dir}\\Windsurf.exe`)) {
      paths.push(`${dir}\\${lsBin}`);
    }
  }
  if (process.env.APPDATA) {
    paths.push(`${process.env.APPDATA}\\Windsurf\\bin\\language_server_windows_x64.exe`);
  }
  // Common install locations on all drives
  for (const drive of ['C', 'D', 'E', 'F']) {
    paths.push(`${drive}:\\Windsurf\\${lsBin}`);
    paths.push(`${drive}:\\Program Files\\Windsurf\\${lsBin}`);
  }
  if (process.env.LOCALAPPDATA) {
    paths.push(`${process.env.LOCALAPPDATA}\\Programs\\Windsurf\\${lsBin}`);
  }
  return paths;
}

const LS_SEARCH_PATHS_WIN = getWinSearchPaths();

const LS_SEARCH_PATHS_LINUX = [
  `${process.env.HOME}/.windsurf/bin/language_server_linux_x64`,
  '/opt/windsurf/language_server_linux_x64',
  '/opt/Windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64',
];

const LS_SEARCH_PATHS_MAC = [
  `${process.env.HOME}/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_arm`,
  `${process.env.HOME}/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_x64`,
];

export function detectLsBinary(): string | null {
  const platform = process.platform;
  let paths: string[] = [];
  if (platform === 'win32') paths = LS_SEARCH_PATHS_WIN;
  else if (platform === 'darwin') paths = LS_SEARCH_PATHS_MAC;
  else paths = LS_SEARCH_PATHS_LINUX;

  // Also check dataDir/bin (downloaded via setup command)
  const binDir = join(config.dataDir, 'bin');
  if (platform === 'win32') paths.push(join(binDir, 'language_server_windows_x64.exe'));
  else if (platform === 'darwin') {
    paths.push(join(binDir, 'language_server_macos_arm'));
    paths.push(join(binDir, 'language_server_macos_x64'));
  } else paths.push(join(binDir, 'language_server_linux_x64'));

  for (const p of paths) {
    if (existsSync(p)) {
      log.info(`Auto-detected LS binary: ${p}`);
      return p;
    }
  }
  return null;
}

function cleanupPreviousLs(port: number): void {
  // Kill residual language_server processes
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq language_server_windows_x64.exe" /FO CSV /NH', { encoding: 'utf-8', timeout: 5000 });
      const pids: number[] = [];
      for (const line of out.split('\n')) {
        const match = line.match(/"language_server_windows_x64\.exe","(\d+)"/i);
        if (match) pids.push(parseInt(match[1], 10));
      }
      for (const pid of pids) {
        log.info(`Killing residual LS process: PID ${pid}`);
        try { execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 }); } catch { /* ignore */ }
      }
    } else {
      try { execSync('pkill -f language_server', { timeout: 5000 }); } catch { /* ignore */ }
    }
  } catch { /* no residual processes */ }

  // Clean child_lock files in temp
  try {
    const tmp = tmpdir();
    const files = readdirSync(tmp).filter(f => f.startsWith('child_lock_'));
    for (const f of files) {
      try { unlinkSync(join(tmp, f)); } catch { /* locked by other process */ }
    }
    if (files.length > 0) log.info(`Cleaned ${files.length} LS lock file(s)`);
  } catch { /* ignore */ }
}

// ─── Desktop LS detection ──────────────────────────────

function findDesktopLsPort(): { port: number; csrf: string } | null {
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config'));
    const logBase = join(appData, 'Windsurf', 'logs');
    if (!existsSync(logBase)) return null;

    // Find the most recent log directory
    const dirs = readdirSync(logBase)
      .filter(d => { try { return statSync(join(logBase, d)).isDirectory(); } catch { return false; } })
      .sort().reverse();

    for (const dir of dirs.slice(0, 3)) {
      // Look for Windsurf.log in exthost subdirs
      const extPattern = join(logBase, dir);
      const logFile = findFile(extPattern, 'Windsurf.log', 4);
      if (!logFile) continue;

      const content = readFileSync(logFile, 'utf-8');
      // Extract port: "Language server listening on ... port at XXXXX"
      const portMatch = content.match(/listening on.*port.*?(\d{4,5})/i)
        || content.match(/manager_port.*?(\d{4,5})/i)
        || content.match(/connected.*language server.*?(\d{4,5})/i);
      if (!portMatch) continue;

      const port = parseInt(portMatch[1], 10);
      if (port < 1024 || port > 65535) continue;

      // Try to find CSRF token from the same log or config
      const csrfMatch = content.match(/csrf[_-]token["=:\s]+([a-zA-Z0-9_-]{10,})/i);
      const csrf = csrfMatch ? csrfMatch[1] : '';

      return { port, csrf };
    }
  } catch (e: any) {
    log.debug('Desktop LS detection failed:', e.message);
  }
  return null;
}

function findFile(dir: string, name: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === name && !statSync(full).isDirectory()) return full;
      if (statSync(full).isDirectory()) {
        const found = findFile(full, name, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* permission denied etc */ }
  return null;
}

async function tryConnectDesktopLs(): Promise<{ port: number; csrfToken: string } | null> {
  const info = findDesktopLsPort();
  if (!info) return null;

  log.info(`Found desktop LS on port ${info.port}, testing connection...`);

  // Try connecting with found CSRF, then empty, then default
  const csrfCandidates = [info.csrf, '', DEFAULT_CSRF].filter(Boolean);
  // Dedup
  const unique = [...new Set(csrfCandidates)];

  for (const csrf of unique) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = http2.connect(`http://localhost:${info.port}`);
        const t = setTimeout(() => { client.close(); reject(new Error('timeout')); }, 3000);
        client.on('connect', () => { clearTimeout(t); client.close(); resolve(); });
        client.on('error', () => { clearTimeout(t); reject(new Error('connect error')); });
      });
      log.info(`Desktop LS reachable on port ${info.port} — reusing (saves ~400MB RAM)`);
      return { port: info.port, csrfToken: csrf };
    } catch { /* try next */ }
  }
  return null;
}

export async function startLanguageServer(opts: {
  binaryPath: string;
  port?: number;
  apiServerUrl?: string;
}): Promise<{ port: number; csrfToken: string }> {
  if (_ready) return { port: _port, csrfToken: _csrfToken };

  // Try reusing desktop client's LS first
  const desktop = await tryConnectDesktopLs();
  if (desktop) {
    _port = desktop.port;
    _csrfToken = desktop.csrfToken;
    _ready = true;
    _usingDesktopLs = true;
    return desktop;
  }

  const binaryPath = opts.binaryPath;
  const port = opts.port || DEFAULT_PORT;
  _port = port;

  if (!existsSync(binaryPath)) {
    throw new Error(`Language Server binary not found: ${binaryPath}`);
  }

  // Kill any residual LS processes and clean lock files
  cleanupPreviousLs(port);

  // Use platform-specific data dirs
  const lsDataDir = join(config.dataDir, 'ls');
  const lsDbDir = join(lsDataDir, 'db');
  if (!existsSync(lsDataDir)) mkdirSync(lsDataDir, { recursive: true });
  if (!existsSync(lsDbDir)) mkdirSync(lsDbDir, { recursive: true });

  const args = [
    `--api_server_url=${opts.apiServerUrl || 'https://server.self-serve.windsurf.com'}`,
    `--server_port=${port}`,
    `--csrf_token=${DEFAULT_CSRF}`,
    '--register_user_url=https://api.codeium.com/register_user/',
    `--codeium_dir=${lsDataDir}`,
    `--database_dir=${lsDbDir}`,
    '--enable_local_search=false',
    '--enable_index_service=false',
    '--enable_lsp=false',
    '--detect_proxy=false',
    '--manager_connect_timeout=5',
    '--manager_max_connection_failures=3',
  ];

  log.info(`Starting LS: ${binaryPath} on port ${port}`);
  const proc = spawn(binaryPath, args, { stdio: 'pipe' });
  _process = proc;

  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) log.debug('[LS]', line.slice(0, 200));
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) log.warn('[LS:err]', line.slice(0, 200));
  });
  let _restartCount = 0;
  const MAX_RESTARTS = 3;
  proc.on('exit', (code) => {
    log.warn(`LS exited: code=${code}`);
    _ready = false;
    _process = null;
    // Auto-restart if crashed unexpectedly
    if (code !== 0 && _restartCount < MAX_RESTARTS) {
      _restartCount++;
      log.info(`Auto-restarting LS (attempt ${_restartCount}/${MAX_RESTARTS})...`);
      setTimeout(() => {
        startLanguageServer(opts).catch(e => log.error('LS restart failed:', e.message));
      }, 2000);
    }
  });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await new Promise<void>((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const t = setTimeout(() => { client.close(); reject(new Error('timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(t); client.close(); resolve(); });
        client.on('error', () => { clearTimeout(t); reject(new Error('connect error')); });
      });
      _ready = true;
      _csrfToken = DEFAULT_CSRF;
      log.info(`LS ready on port ${port}`);
      return { port, csrfToken: DEFAULT_CSRF };
    } catch { /* retry */ }
  }
  throw new Error('LS failed to start within 30s');
}

export function stopLanguageServer(): void {
  if (_usingDesktopLs) {
    log.info('Detaching from desktop LS (not killing it)');
    _ready = false;
    _usingDesktopLs = false;
    return;
  }
  if (_process) {
    try { _process.kill('SIGKILL'); } catch { /* ignore */ }
    _process = null;
  }
  _ready = false;
}

export function getLsPort(): number { return _port; }
export function getCsrfToken(): string { return _csrfToken; }
export function isLsReady(): boolean { return _ready; }
export function isUsingDesktopLs(): boolean { return _usingDesktopLs; }
