/**
 * Language server process manager.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http2 from 'http2';
import { config, log } from '../config.js';
import { WindsurfClient } from './client.js';

const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-token';

let _process: ReturnType<typeof spawn> | null = null;
let _port = DEFAULT_PORT;
let _csrfToken = DEFAULT_CSRF;
let _ready = false;
let _reusingLs = false;
let _restartCount = 0;

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
  // Only kill LS processes that WE previously started (check state file for PID)
  // NEVER kill all LS processes — the desktop client uses one too
  const prevState = loadOwnLsState();
  if (prevState?.pid) {
    try {
      log.info(`Killing our previous LS process: PID ${prevState.pid}`);
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${prevState.pid} /F /T`, { timeout: 5000 });
      } else {
        process.kill(prevState.pid, 'SIGKILL');
      }
    } catch { /* already dead */ }
    clearOwnLsState();
  }

  // Also check if something is listening on our target port
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf-8', timeout: 5000 });
      const listeningMatch = out.match(/LISTENING\s+(\d+)/);
      if (listeningMatch) {
        const pid = parseInt(listeningMatch[1], 10);
        log.info(`Killing process on port ${port}: PID ${pid}`);
        try { execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000 }); } catch { /* ignore */ }
      }
    }
  } catch { /* no conflict */ }

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

// ─── Own LS reuse detection ─────────────────────────────

const LS_STATE_FILE = join(config.dataDir, 'ls-state.json');

function saveOwnLsState(port: number, csrf: string, pid: number): void {
  try {
    writeFileSync(LS_STATE_FILE, JSON.stringify({ port, csrf, pid, ts: Date.now() }));
  } catch { /* ignore */ }
}

function loadOwnLsState(): { port: number; csrf: string; pid: number } | null {
  try {
    if (!existsSync(LS_STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(LS_STATE_FILE, 'utf-8'));
    // Check if the process is still alive
    if (data.pid) {
      try { process.kill(data.pid, 0); } catch { return null; } // process dead
    }
    return data;
  } catch { return null; }
}

function clearOwnLsState(): void {
  try { unlinkSync(LS_STATE_FILE); } catch { /* ignore */ }
}

async function tryReuseOwnLs(): Promise<{ port: number; csrfToken: string } | null> {
  const state = loadOwnLsState();
  if (!state) return null;

  try {
    await new Promise<void>((resolve, reject) => {
      const client = http2.connect(`http://localhost:${state.port}`);
      const cleanup = () => { try { client.close(); } catch {} try { client.destroy(); } catch {} };
      const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 2000);
      client.on('connect', () => { clearTimeout(t); cleanup(); resolve(); });
      client.on('error', () => { clearTimeout(t); cleanup(); reject(new Error('connect error')); });
    });
    log.info(`Reusing previous LS on port ${state.port} (PID ${state.pid})`);
    return { port: state.port, csrfToken: state.csrf };
  } catch {
    clearOwnLsState();
    return null;
  }
}

export async function startLanguageServer(opts: {
  binaryPath: string;
  port?: number;
  apiServerUrl?: string;
}): Promise<{ port: number; csrfToken: string }> {
  if (_ready) return { port: _port, csrfToken: _csrfToken };

  // Try reusing own previous LS if still alive
  const reused = await tryReuseOwnLs();
  if (reused) {
    _port = reused.port;
    _csrfToken = reused.csrfToken;
    _ready = true;
    _reusingLs = true;
    return reused;
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
  const MAX_RESTARTS = 3;
  proc.on('exit', (code) => {
    log.warn(`LS exited: code=${code}`);
    _ready = false;
    _process = null;
    WindsurfClient.resetWarmup(); // Force re-warmup on next LS instance
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
        const cleanup = () => { try { client.close(); } catch {} try { client.destroy(); } catch {} };
        const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(t); cleanup(); resolve(); });
        client.on('error', () => { clearTimeout(t); cleanup(); reject(new Error('connect error')); });
      });
      _ready = true;
      _csrfToken = DEFAULT_CSRF;
      _restartCount = 0; // Reset on successful start
      log.info(`LS ready on port ${port}`);
      // Save state for reuse on next startup
      if (proc.pid) saveOwnLsState(port, DEFAULT_CSRF, proc.pid);
      return { port, csrfToken: DEFAULT_CSRF };
    } catch { /* retry */ }
  }
  throw new Error('LS failed to start within 30s');
}

export function stopLanguageServer(kill = false): void {
  if (_reusingLs) {
    log.info('Detaching from reused LS (keeping alive for next start)');
    _ready = false;
    _reusingLs = false;
    return;
  }
  if (_process) {
    if (kill) {
      log.info('Killing LS process');
      clearOwnLsState();
      try { _process.kill('SIGKILL'); } catch { /* ignore */ }
    } else {
      log.info('Detaching from LS (keeping alive for fast restart)');
      // Don't kill — leave running for reuse
    }
    _process = null;
  }
  _ready = false;
}

export function getLsPort(): number { return _port; }
export function getCsrfToken(): string { return _csrfToken; }
export function isLsReady(): boolean { return _ready; }
export function isReusingLs(): boolean { return _reusingLs; }
