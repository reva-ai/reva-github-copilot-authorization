import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CopilotSettingsReva = {
  authToken?: string;
  host?: string;
  agentId?: string;
  userEmail?: string;
  debug?: boolean;
};

// Copilot settings.json is JSONC. Strip // and /* */ comments before JSON.parse.
function stripJsonc(raw: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function resolveCopilotSettingsPath(): string {
  return path.join(os.homedir(), '.copilot', 'settings.json');
}

// Parses a Copilot JSON/JSONC file; undefined when missing or malformed.
export function readCopilotJsonc(file: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// MCP servers turned off with `copilot mcp disable <name>`. As of CLI
// 1.0.97 the name is appended to settings.json `disabledMcpServers` and
// removed again by `copilot mcp enable` (mcp-config.json is left untouched).
export function readDisabledMcpServers(settingsPath?: string): string[] {
  const list = readCopilotJsonc(settingsPath || resolveCopilotSettingsPath())?.disabledMcpServers;
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// Reads Reva fields from ~/.copilot/settings.json.
// Accepts:
//   - top-level REVA_* keys
//   - settings.env.REVA_* (an `env` block)
//   - nested "reva" object
// Unknown keys may show under Copilot's /settings Problems tab.
// `settingsPath` is for tests only — production always uses ~/.copilot/settings.json.
export function readCopilotSettingsReva(settingsPath?: string): CopilotSettingsReva {
  const file = settingsPath || resolveCopilotSettingsPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};

    const settingsEnv =
      parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
        ? (parsed.env as Record<string, unknown>)
        : {};

    const nested =
      parsed.reva && typeof parsed.reva === 'object' && !Array.isArray(parsed.reva)
        ? (parsed.reva as Record<string, unknown>)
        : {};

    const debugRaw = pickString(
      settingsEnv.REVA_DEBUG,
      parsed.REVA_DEBUG,
      nested.debug !== undefined && nested.debug !== null ? String(nested.debug) : undefined,
    );
    const debugFlag =
      settingsEnv.REVA_DEBUG === true ||
      parsed.REVA_DEBUG === true ||
      nested.debug === true ||
      (debugRaw !== undefined &&
        debugRaw !== '0' &&
        debugRaw.toLowerCase() !== 'false');

    return {
      // Prefer env{} (documented customer shape), then top-level, then reva{}.
      authToken: pickString(
        settingsEnv.REVA_AUTH_TOKEN,
        parsed.REVA_AUTH_TOKEN,
        nested.authToken,
        nested.auth_token,
        nested.REVA_AUTH_TOKEN,
      ),
      host: pickString(settingsEnv.REVA_HOST, parsed.REVA_HOST, nested.host, nested.REVA_HOST),
      agentId: pickString(
        settingsEnv.REVA_AGENT_ID,
        parsed.REVA_AGENT_ID,
        nested.agentId,
        nested.agent_id,
        nested.REVA_AGENT_ID,
      ),
      // Reva tokens / CODE_USER_SCOPE are keyed to a real email (often Gmail).
      // Set this when the GitHub email is private (only a public one can be
      // read) — the same address the store knows.
      userEmail: pickString(
        settingsEnv.REVA_USER_EMAIL,
        parsed.REVA_USER_EMAIL,
        nested.userEmail,
        nested.user_email,
        nested.REVA_USER_EMAIL,
      ),
      debug: debugFlag || undefined,
    };
  } catch {
    return {};
  }
}
