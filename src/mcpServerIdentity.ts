import * as fs from 'node:fs';
import * as path from 'node:path';

// One identifier for an MCP server, shared by discovery (mcpDiscovery.ts)
// and enforcement (mapping.ts). The canonical id is a slug derived from the
// server's DISPLAY name — "Google Calendar" -> google-calendar. Both sides
// converge on it: discovery slugifies the names it reads from disk, and
// enforcement slugifies the server token in the tool name the same way.
//
// Slugging applies to EVERYTHING — display names and machine tokens alike.
// A .mcp.json key and the non-uuid half of an mcp__<server>__<tool> name all
// go through the same function, so one id format holds across every source.
//
// Copilot has no desktop-app session files to scan for a uuid → display-name
// mapping, so refreshMcpServerIdentityCache is a no-op that returns empty;
// resolve still slugifies non-uuid tokens and can read a cache if one were
// ever written elsewhere.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these two connector-name prefixes are stripped, so a .mcp.json entry
// that uses one resolves to the same slug as the bare name.
const CLAUDE_AI_PREFIX = /^claude\.ai\s+|^claude_ai_/i;

export interface McpServerIdentity {
  // The canonical id — what both MCPServer entity ids and Cedar policies use.
  slug: string;
  // Human-readable name, when one is known. Absent for a bare uuid that
  // isn't in the cache yet.
  displayName?: string;
  // Present for a remote connector — absent for stdio/local servers.
  url?: string;
  // Global connector id, when this identity came from one.
  uuid?: string;
}

export function slugifyMcpServerName(raw: string): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(CLAUDE_AI_PREFIX, '');
  // A name that is ENTIRELY the prefix ("claude.ai ") would strip to nothing
  // — keep the original in that case rather than returning an empty id.
  const base = stripped.trim().length > 0 ? stripped : raw;
  return base
    .toLowerCase()
    .replace(/[\s._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isMcpServerUuid(token: string): boolean {
  return typeof token === 'string' && UUID_PATTERN.test(token);
}

function identityCachePath(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'mcp-server-identity.json') : undefined;
}

export function loadMcpServerIdentityCache(pluginDataDir?: string): Record<string, McpServerIdentity> {
  const file = identityCachePath(pluginDataDir);
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// No-op on Copilot: there is no desktop session-file source to scan. Returns
// whatever is already cached (usually empty) without writing.
export function refreshMcpServerIdentityCache(pluginDataDir?: string): Record<string, McpServerIdentity> {
  return loadMcpServerIdentityCache(pluginDataDir);
}

// Invoke-time resolution of the server token in an mcp__<server>__<tool>
// (or mcp/<server>/<tool>) name. A uuid is looked up in the cache; anything
// else is slugified directly.
//
// On a cache MISS for a uuid the raw token is returned unchanged —
// deliberately never a fabricated slug. A uuid carries no name, so there is
// nothing honest to derive from it.
export function resolveMcpServerIdentity(token: string, pluginDataDir?: string): McpServerIdentity {
  if (!isMcpServerUuid(token)) {
    return { slug: slugifyMcpServerName(token) || token };
  }
  const uuid = token.toLowerCase();
  const cached = loadMcpServerIdentityCache(pluginDataDir)[uuid];
  if (cached && typeof cached.slug === 'string' && cached.slug.length > 0) return cached;
  return { slug: uuid, uuid };
}
