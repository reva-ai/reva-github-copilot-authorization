import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveCopilotModel } from './copilotModel';
import { resolveMachineId } from './deviceId';
import { loadAgentHops, resolveSubAgentLineage, startTurnHops } from './hopChain';
import { writePromptDecision } from './hookOutput';
import { resolveSessionEntrypointForSession, resolveUserEmail } from './identity';
import { recordAgentModel } from './ingestionClient';
import { buildInvokeAgentRequest } from './invokeAgent';
import { normalizeUserPrompt } from './normalize';
import { triggerMcpDiscoveryIfDue } from './mcpIngestionTrigger';
import { evaluate } from './rtgClient';
import { resolvePluginDataDir } from './pluginData';
import { resetSpawnCounter } from './spawnCounter';
import { readStdin } from './stdin';
import { buildSessionContext, deriveSpanId, traceparentHeader } from './trace';
import { registerSubAgent, resolveSubAgent } from './subAgentRegistry';
import { CedarHop, RtgResult, UserPromptSubmitInput } from './types';
import { directSessionFromTurn, resolveTurnTraceId, startTurn, truncatePrompt } from './turnCache';

function registerSubAgentKickoff(input: UserPromptSubmitInput, pluginDataDir?: string): void {
  const parentSessionId = input.parent_agent_id!;
  const subAgentId = input.agent_id!;
  // Spawns and kickoffs happen in the same order, so the oldest lineage the
  // parent queued is this child's. If none is queued (the spawn's own hook
  // failed or predates this plugin version), fall back to the parent's
  // known chain rather than inventing a spawn hop.
  const parent = resolveSubAgent(parentSessionId, pluginDataDir);
  let lineage = resolveSubAgentLineage(parentSessionId, subAgentId, pluginDataDir);
  if (lineage.length === 0) {
    lineage = parent ? parent.lineage : loadAgentHops(parentSessionId, pluginDataDir);
  }
  registerSubAgent(
    input.session_id,
    {
      subAgentId,
      parentSessionId,
      agentType: input.agent_type || 'subagent',
      lineage,
      registeredAt: new Date().toISOString(),
    },
    pluginDataDir,
  );
  debugLog(
    `-> subagent kickoff ${subAgentId} (type=${input.agent_type || 'subagent'}, parent=${parentSessionId}, hops=${lineage.length}) — not evaluated; gated by the parent's spawn`,
  );
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = normalizeUserPrompt(JSON.parse(raw));
  const pluginDataDir = resolvePluginDataDir();

  // A Copilot subagent starting up, not a human turn: its sessionId is its
  // own agentId and parentAgentId names the session that spawned it. The
  // parent's `task` preToolUse already evaluated this as `spawn`, so there
  // is nothing to gate here — evaluating it as User → invokeAgent would
  // report the model-written subagent prompt as if the human typed it, and
  // starting a turn under the subagent's id is what split each subagent
  // into its own Reva session. Just bind it to its lineage and step aside.
  if (input.agent_id && input.parent_agent_id) {
    registerSubAgentKickoff(input, pluginDataDir);
    process.exit(0);
  }

  const cfg = loadConfig();

  // Closes the gap between SessionStart's once-per-session discovery pass
  // and a connector added mid-session: userPromptSubmitted fires every turn,
  // so re-checking here (throttled to ~15 minutes, see
  // mcpIngestionTrigger.ts) picks up a new connector well before the next
  // SessionStart would. A no-op, non-blocking cache read when not yet due.
  triggerMcpDiscoveryIfDue(input.cwd, pluginDataDir);

  const userEmail = resolveUserEmail();
  const prompt = input.prompt ? truncatePrompt(input.prompt) : '';

  const currentSession = markSessionActive(
    cfg.agentId,
    input.session_id,
    resolveSessionEntrypointForSession({ agentId: cfg.agentId, sessionId: input.session_id, pluginDataDir }),
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  const turn = startTurn(input.session_id, input.prompt, pluginDataDir);
  resetSpawnCounter(input.session_id, pluginDataDir);
  // This hook opens the turn, so its trace id is the one every tool call in
  // the turn will read back. Its own span is the prompt evaluation itself.
  const traceId = resolveTurnTraceId(input.session_id, turn);
  const spanId = deriveSpanId(traceId, 'user-prompt');
  const traceSession = buildSessionContext(input.session_id, spanId, traceId, input.prompt_id);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  // Always evaluate invokeAgent for hops + audit. Copilot command hooks for
  // userPromptSubmitted often cannot block the turn — preToolUse is the
  // real enforcement gate (see hookOutput.writePromptDecision).
  // The model Copilot routed this prompt to (Auto resolves it before this
  // hook fires). Read from Copilot's own session record — see copilotModel.ts.
  const model = resolveCopilotModel({ sessionId: input.session_id });

  const request = buildInvokeAgentRequest(
    userEmail,
    cfg.agentId,
    prompt || '(empty prompt)',
    directSessionFromTurn(input.session_id, turn),
    activeSessionCount,
    currentSession,
    resolveMachineId(pluginDataDir),
    { model, modelContext: cfg.modelContext },
  );

  debugLog(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId}${model ? ` (model=${model})` : ''}`);
  // Agent.models is recorded alongside the evaluation, not before it, so a
  // new model adds no latency to the prompt. Best-effort; never throws.
  const [result] = await Promise.all([
    evaluate(cfg, request, traceparent, pluginDataDir, input.session_id),
    recordAgentModel(cfg, cfg.agentId, model, pluginDataDir),
  ]);
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);

  const invokeAgentHop: CedarHop = {
    seq: 1,
    subject: request.subject,
    action: { name: 'invokeAgent' },
    resource: request.resource,
    time: new Date().toISOString(),
  };
  startTurnHops(input.session_id, invokeAgentHop, pluginDataDir);

  writePromptDecision(result);
}

main().catch((err: any) => {
  debugLog(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  writePromptDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  } satisfies RtgResult);
});
