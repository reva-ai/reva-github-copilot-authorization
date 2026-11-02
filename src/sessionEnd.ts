import { markSessionInactive } from './activeSessions';
import { debugLog } from './debug';
import { resolveConfiguredAgentId } from './config';
import { resolvePluginDataDir } from './pluginData';
import { readStdin } from './stdin';
import { removeSubAgentsOfSession } from './subAgentRegistry';

// SessionEnd has no blocking/decision control (same as SessionStart) — it's
// pure local cleanup, immediately removing this session from the active-
// sessions registry (activeSessions.ts) rather than waiting out that file's
// 10-minute TTL. Not guaranteed to fire on an abrupt termination (killed
// process, closed terminal) — the TTL stays as the fallback for exactly
// that gap; this is just the fast path for a graceful one. No RTG call, no
// full loadConfig(): nothing here is worth a network round-trip against
// Copilot's tight, shared SessionEnd execution budget.
interface SessionEndInput {
  sessionId?: string;
  session_id?: string;
  cwd?: string;
}

function pickSessionId(input: SessionEndInput): string {
  const id = input.sessionId ?? input.session_id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: SessionEndInput = JSON.parse(raw || '{}');
  const pluginDataDir = resolvePluginDataDir();

  // Drop this session's subagent registrations (subAgentRegistry.ts) — pure
  // local cleanup, no identity needed.
  try {
    removeSubAgentsOfSession(pickSessionId(input), pluginDataDir);
  } catch (err: any) {
    debugLog(`sessionEnd: removeSubAgentsOfSession failed — ${err?.message || String(err)}`);
  }

  // Cache only: no gh process inside Copilot's ~1.5s SessionEnd budget.
  const agentId = resolveConfiguredAgentId(process.env, undefined, { allowLookup: false });
  if (!agentId) {
    debugLog('sessionEnd: skipped — no cached Copilot account id and REVA_AGENT_ID not set');
  } else {
    try {
      markSessionInactive(agentId, pickSessionId(input), pluginDataDir);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
