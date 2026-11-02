import * as os from 'node:os';
import * as path from 'node:path';
import { readCopilotJsonc, readDisabledMcpServers } from './copilotSettings';
import { slugifyMcpServerName } from './mcpServerIdentity';

// Pure, synchronous, file-based MCP server discovery — no CLI, no network,
// no live health-check. Replaces the old `copilot mcp list` shell-out.
//
// The same sources `copilot mcp --help` lists, each best-effort and
// independently fault-tolerant — a missing or malformed file just
// contributes nothing, never an error:
//   1. Project-scoped:  <cwd>/.mcp.json
//   2. GitHub-scoped:   <cwd>/.github/mcp.json
//   3. User-scoped:     ~/.copilot/mcp-config.json — what `copilot mcp add`
//      writes, as { "mcpServers": { <name>: {type, command/args | url} } }
//      (as of CLI 1.0.97).
//   4. Built-in:        github-mcp-server, which Copilot ships enabled and
//      lists under "Builtin servers". Name only — its URL depends on the
//      user's Copilot plan, so none is fabricated; it lands as a
//      registeredMcpServers name rather than an MCPServer entity.
// Anything the user turned off (settings.json disabledMcpServers) is
// dropped, from every source.
//
// Every name returned here is a SLUG (see mcpServerIdentity.ts) — the same
// canonical id mapping.ts emits at invoke time, so the inventory side and
// the enforcement side join. The original spelling rides along as
// displayName when present.
//
// Plugin-bundled servers are not discovered (none of ours bundle any).

export interface DiscoveredMcpServer {
  // The server's canonical id, matching what mapping.ts emits at invoke time.
  name: string;
  // Present for a remote/http server; absent for stdio/local-only, or any
  // malformed entry — never fabricated. A stdio server is still genuinely
  // "configured on this machine" even with no url to report (see callers).
  url?: string;
  // The name as it was actually written wherever it was found, before
  // slugging — kept so the entity stays readable in Reva.
  displayName?: string;
}

interface McpJsonServerEntry {
  url?: string;
  [key: string]: any;
}

const BUILTIN_MCP_SERVERS = ['github-mcp-server'];

function toDiscovered(servers: Record<string, McpJsonServerEntry> | undefined): DiscoveredMcpServer[] {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, entry]) => ({
    name: slugifyMcpServerName(name) || name,
    displayName: name,
    url: typeof entry?.url === 'string' ? entry.url : undefined,
  }));
}

function mcpJsonFileServers(filePath: string): DiscoveredMcpServer[] {
  return toDiscovered(readCopilotJsonc(filePath)?.mcpServers);
}

// First occurrence wins on a slug collision across sources — deterministic
// (.mcp.json, .github/mcp.json, user config, then built-in), so a workspace
// definition takes precedence over the user's own. `home` is for tests.
export function discoverMcpServers(cwd: string, home: string = os.homedir()): DiscoveredMcpServer[] {
  const all = [
    ...mcpJsonFileServers(path.join(cwd, '.mcp.json')),
    ...mcpJsonFileServers(path.join(cwd, '.github', 'mcp.json')),
    ...mcpJsonFileServers(path.join(home, '.copilot', 'mcp-config.json')),
    ...BUILTIN_MCP_SERVERS.map((name) => ({ name: slugifyMcpServerName(name) || name, displayName: name })),
  ];
  const disabled = new Set(readDisabledMcpServers(path.join(home, '.copilot', 'settings.json')));
  const seen = new Set<string>();
  const result: DiscoveredMcpServer[] = [];
  for (const entry of all) {
    if (seen.has(entry.name)) continue;
    if (disabled.has(entry.displayName || entry.name) || disabled.has(entry.name)) continue;
    seen.add(entry.name);
    result.push(entry);
  }
  return result;
}
