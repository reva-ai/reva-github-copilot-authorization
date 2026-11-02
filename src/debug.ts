import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCopilotSettingsReva } from './copilotSettings';
import { resolvePluginDataDir } from './pluginData';

const LOG_FILENAME = 'reva-debug.log';

function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = env.REVA_DEBUG?.trim();
  if (fromEnv && fromEnv !== '0' && fromEnv.toLowerCase() !== 'false') return true;
  return Boolean(readCopilotSettingsReva().debug);
}

function resolveLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = resolvePluginDataDir(env);
  if (dataDir?.trim()) return path.join(dataDir.trim(), LOG_FILENAME);
  return path.join(os.homedir(), '.copilot-governance', LOG_FILENAME);
}

let cachedEnabled: boolean | undefined;
let cachedLogFile: string | undefined;

function isEnabled(): boolean {
  if (cachedEnabled === undefined) cachedEnabled = debugEnabled();
  return cachedEnabled;
}

function logFile(): string {
  if (!cachedLogFile) cachedLogFile = resolveLogFile();
  return cachedLogFile;
}

// Opt-in via REVA_DEBUG (env or ~/.copilot/settings.json). Always writes to
// stderr (unmodified). Also appends a timestamped copy to the plugin data
// dir log — Copilot's TUI often hides hook stderr, and the file accumulates
// across every hook invocation, so timestamps matter there. Stderr's own
// line stays untimestamped since nothing else about its format has changed.
export function debugLog(message: string): void {
  if (!isEnabled()) return;
  try {
    process.stderr.write(`[reva-security] ${message}\n`);
  } catch {
    // ignore
  }
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // ignore — never fail a hook over logging
  }
}

export function debugLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveLogFile(env);
}

export function _resetDebugCacheForTests(): void {
  cachedEnabled = undefined;
  cachedLogFile = undefined;
}
