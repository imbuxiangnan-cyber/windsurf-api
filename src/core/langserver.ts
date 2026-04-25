/**
 * Language server process manager.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http2 from 'http2';
import { config, log } from '../config.js';

const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windsurf-api-csrf-token';

let _process: ReturnType<typeof spawn> | null = null;
let _port = DEFAULT_PORT;
let _ready = false;

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

export async function startLanguageServer(opts: {
  binaryPath: string;
  port?: number;
  apiServerUrl?: string;
}): Promise<{ port: number; csrfToken: string }> {
  if (_ready) return { port: _port, csrfToken: DEFAULT_CSRF };

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
  proc.on('exit', (code) => {
    log.warn(`LS exited: code=${code}`);
    _ready = false;
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
      log.info(`LS ready on port ${port}`);
      return { port, csrfToken: DEFAULT_CSRF };
    } catch { /* retry */ }
  }
  throw new Error('LS failed to start within 30s');
}

export function stopLanguageServer(): void {
  if (_process) {
    try { _process.kill('SIGKILL'); } catch { /* ignore */ }
    _process = null;
  }
  _ready = false;
}

export function getLsPort(): number { return _port; }
export function getCsrfToken(): string { return DEFAULT_CSRF; }
export function isLsReady(): boolean { return _ready; }
