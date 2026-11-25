import { truncateAssistantOutput } from './assistantOutput';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { normalizeStop } from './normalize';
import { resolvePluginDataDir } from './pluginData';
import { isCircuitOpen } from './rtgCircuitBreaker';
import { summarizeTrace } from './rtgClient';
import { readStdin } from './stdin';
import { resolveSubAgent } from './subAgentRegistry';
import { loadTurn, resolveTurnTraceId } from './turnCache';

// Copilot CLI's agentStop (VS Code Copilot Chat's Stop) fires when the main
// agent finishes a turn. That is the natural close of one prompt trace: the
// evaluate calls already gave Reva the hops; summarize asks Reva to write the
// trace summary. Best-effort — a failed summarize must never block or alter
// Copilot, so this hook writes nothing to stdout (any decision output would
// be read as `block`, which forces another turn) and always exits 0.
async function main(): Promise<void> {
  const raw = await readStdin();
  const input = normalizeStop(JSON.parse(raw || '{}'));
  const pluginDataDir = resolvePluginDataDir();

  try {
    // agentStop is the main agent's turn; a registered subagent session has
    // no turn of its own to close.
    if (resolveSubAgent(input.session_id, pluginDataDir)) {
      debugLog('stop: skip summarize — sub-agent session');
      process.exit(0);
    }

    // After a 401 the plugin stops calling Reva for the rest of the session.
    if (isCircuitOpen(input.session_id, pluginDataDir).open) {
      debugLog('stop: skip summarize — circuit open for this session');
      process.exit(0);
    }

    const cfg = loadConfig();
    const turn = loadTurn(input.session_id, pluginDataDir);
    if (!turn) {
      debugLog('stop: skip summarize — no turn cache entry');
      process.exit(0);
    }

    // Copilot's agentStop payload carries a transcript path, not the reply
    // itself, so `output` is only sent when the host supplies the reply.
    const output = truncateAssistantOutput(input.last_assistant_message);
    if (!output) debugLog('stop: no assistant output in the hook input — summarizing without it');

    const traceId = resolveTurnTraceId(input.session_id, turn);
    const result = await summarizeTrace(cfg, {
      trace_id: traceId,
      thread_id: input.session_id,
      ...(output ? { output } : {}),
    });
    if (result.ok) {
      debugLog(`stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output, 'utf8')}`);
    } else {
      debugLog(`stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`);
    }
  } catch (err: any) {
    debugLog(`stop: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
