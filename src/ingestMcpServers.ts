import { loadConfig } from './config';
import { debugLog } from './debug';
import { ingestDiscoveredMcpServers, resolveEntityTypeIds } from './ingestionClient';
import { discoverMcpServers, DiscoveredMcpServer } from './mcpDiscovery';
import { resolveUserEmail } from './identity';
import { refreshMcpServerIdentityCache } from './mcpServerIdentity';
import { resolvePluginDataDir } from './pluginData';

// MCP server discovery — deliberately split out from sessionStart.ts's own
// blocking User/Agent ingestion and run as a detached child process instead.
// Discovery itself (mcpDiscovery.ts) is just a handful of local file reads,
// genuinely fast — but *ingesting* what it finds still means a network call
// to Reva per newly-discovered server. By the time this process starts,
// sessionStart.js has already exited, so however long this takes, or however
// it fails, cannot block a session again.
//
// cwd arrives via REVA_SESSION_CWD (set by the spawning sessionStart /
// authorizePrompt) rather than stdin — this process has no hook input of
// its own to read.

async function main(): Promise<void> {
  const pluginDataDir = resolvePluginDataDir();
  const cwd = process.env.REVA_SESSION_CWD || process.cwd();

  // No-op refresh on Copilot (no desktop session files) — kept so a future
  // cache writer still has a hook point.
  try {
    refreshMcpServerIdentityCache(pluginDataDir);
  } catch (err: any) {
    debugLog(`ingestMcpServers: MCP server identity refresh failed — continuing (${err?.message || String(err)})`);
  }

  // What this pass ingests: everything discovery finds, PLUS the server whose
  // tool just got invoked, when the PreToolUse path spawned us with one.
  //
  // That addition is the whole point of ingest-on-invoke. Discovery reads
  // config files, so it structurally CANNOT see an app-provided / invoked-
  // only server. Those exist only as evidence in a tool name.
  //
  // No url is available at invoke time, so it lands as a registeredMcpServers
  // name only — no MCPServer entity. It arrives ALREADY slugged: authorize.ts
  // passes the MCPServer parent id that mapping.ts produced.
  const invoked = process.env.REVA_INVOKED_MCP_SERVER?.trim();
  const discover = (at: string): DiscoveredMcpServer[] => {
    const found = discoverMcpServers(at);
    if (!invoked || found.some((entry) => entry.name === invoked)) return found;
    debugLog(`ingestMcpServers: including invoked-but-undiscoverable server "${invoked}"`);
    return [...found, { name: invoked, displayName: invoked, url: undefined }];
  };

  try {
    const cfg = loadConfig();
    const userEmail = resolveUserEmail();

    const { userEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);

    if (!mcpServerEntityTypeId) {
      debugLog('ingestMcpServers: skipped — could not resolve MCPServer entity type id');
    } else {
      await ingestDiscoveredMcpServers(cfg, mcpServerEntityTypeId, cwd, pluginDataDir, userEntityTypeId, userEmail, discover).catch(
        (err) => debugLog(`ingestMcpServers: ingest discovered MCP servers failed — ${err}`),
      );
    }
  } catch (err: any) {
    debugLog(`ingestMcpServers: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
