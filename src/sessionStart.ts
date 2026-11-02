import { markSessionActive } from './activeSessions';
import { loadConfig, resolveConfiguredAgentId } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { ingestAgent, ingestUser, recordMcpDiscoveryTriggered, resolveEntityTypeIds } from './ingestionClient';
import { resolveSessionEntrypointForSession, resolveUserEmail } from './identity';
import { spawnMcpIngestion } from './mcpIngestionTrigger';
import { normalizeSessionStart } from './normalize';
import { resolvePluginDataDir } from './pluginData';
import { readStdin } from './stdin';

// SessionStart has no blocking/decision control — but unlike a plain no-op,
// this hook deliberately waits for User/Agent ingestion before exiting:
// Cedar policies that check a STORED registration need that PATCH to have
// already landed. User and Agent run concurrently (different entities, no
// shared writes).
//
// MCP server discovery/ingestion is deliberately NOT part of this wait:
// it's spawned below as a fully detached, unref'd child — after the forced
// entity-type refresh, so that child reads the freshly-replaced cache.

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = normalizeSessionStart(JSON.parse(raw || '{}'));
  const pluginDataDir = resolvePluginDataDir();

  const agentId = resolveConfiguredAgentId();
  if (!agentId) {
    debugLog(
      'sessionStart: skipped active-session tracking — no Copilot account id and REVA_AGENT_ID not set',
    );
  } else {
    try {
      markSessionActive(
        agentId,
        input.session_id,
        // Environment only: the once-per-session parent-process check runs on
        // the first prompt or tool hook instead, outside this 10 s budget.
        resolveSessionEntrypointForSession({
          agentId,
          sessionId: input.session_id,
          pluginDataDir,
          allowProcessLookup: false,
        }),
        pluginDataDir,
      );
    } catch (err: any) {
      debugLog(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
    }
  }

  try {
    const cfg = loadConfig();

    // Forced fresh fetch, replacing whatever's cached, once per session —
    // rather than only reacting after something has already failed against
    // a stale cached id. Done BEFORE spawning MCP ingestion below so that
    // detached child reads the freshly-replaced cache.
    const { userEntityTypeId, agentEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir, true);

    // Started before the blocking work below so its own latency overlaps
    // with it instead of stacking on top of it. Unconditional, every
    // session — but still records the trigger time so a throttled
    // UserPromptSubmit recheck doesn't immediately re-trigger.
    spawnMcpIngestion(input.cwd || process.cwd(), pluginDataDir);
    recordMcpDiscoveryTriggered(pluginDataDir);

    const userEmail = resolveUserEmail();

    try {
      const tasks: Promise<void>[] = [];

      if (!userEntityTypeId) {
        debugLog('sessionStart: skipped User ingestion — could not resolve entity type id');
      } else {
        const machineId = resolveMachineId(pluginDataDir);
        tasks.push(
          ingestUser(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId, pluginDataDir).catch((err: unknown) =>
            debugLog(`sessionStart: ingest User failed — ${err}`),
          ),
        );
      }

      if (!agentEntityTypeId) {
        debugLog('sessionStart: skipped Agent ingestion — could not resolve entity type id');
      } else {
        tasks.push(
          ingestAgent(cfg, agentEntityTypeId, cfg.agentId, userEmail, pluginDataDir).catch((err: unknown) =>
            debugLog(`sessionStart: ingest Agent failed — ${err}`),
          ),
        );
      }

      await Promise.all(tasks);
    } catch (err: any) {
      debugLog(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
    }
  } catch (err: any) {
    debugLog(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
