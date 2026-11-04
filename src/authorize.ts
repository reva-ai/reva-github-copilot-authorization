import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { buildActionContext, buildTransmission } from './context';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveCopilotModel } from './copilotModel';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf, refOf } from './entity';
import { evaluateAll, toHookResult } from './evaluateAll';
import { applyIndirectExecutionFloor, detectIndirectExecution } from './indirectExecution';
import { enqueuePendingSpawnLineage } from './hopChain';
import { writePreToolUseDecision } from './hookOutput';
import { resolveCaller, resolveSessionEntrypointForSession, resolveUserEmail } from './identity';
import { mapToolCall } from './mapping';
import { triggerMcpIngestionForInvokedServer } from './mcpIngestionTrigger';
import { normalizePreToolUse } from './normalize';
import { resolvePluginDataDir } from './pluginData';
import { readStdin } from './stdin';
import { nextSpawnIndex } from './spawnCounter';
import { buildTraceId, deriveSpanId, toolSpanKey, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarHop, CedarRequest, RtgResult } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId } from './turnCache';

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = normalizePreToolUse(JSON.parse(raw));
  const cfg = loadConfig();
  const pluginDataDir = resolvePluginDataDir();

  // A Copilot subagent's calls arrive under its own sessionId; caller.sessionId
  // is the user's root session, which every session-scoped value below uses.
  const caller = resolveCaller(cfg.agentId, input, pluginDataDir);
  const sessionId = caller.sessionId;

  const currentSession = markSessionActive(
    cfg.agentId,
    sessionId,
    resolveSessionEntrypointForSession({ agentId: cfg.agentId, sessionId, pluginDataDir }),
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  // An MCP call's server is read from Copilot's session record — the hook's
  // own session first, then the root's (see copilotMcp.ts). authorizePost.ts
  // passes the same ids, so a pre/post pair maps to the same resource.
  const toolMapping = mapToolCall(input.tool_name, input.tool_input || {}, input.cwd, {
    sessionIds: [input.session_id, sessionId],
  });

  // A shell command naming more distinct paths than one call evaluates:
  // denied rather than evaluated partially or widened to a common ancestor,
  // either of which would let a narrower path policy be bypassed.
  if (toolMapping.overCap) {
    debugLog(`-> ${input.tool_name}: ${toolMapping.candidateCount} paths — over the per-call limit, denied`);
    writePreToolUseDecision({
      decision: 'deny',
      reason: `Reva governance: this command touches ${toolMapping.candidateCount} distinct paths, more than can be authorized in one call. Split it into smaller commands.`,
    });
  }

  // No identifiable resource. Only apply_patch can get here (every other tool
  // falls back to a concrete resource): its envelope named no file, and a
  // mutation whose target is unknown must not pass silently.
  if (toolMapping.mappings.length === 0) {
    debugLog(`-> ${input.tool_name}: no resources could be determined — failing closed`);
    writePreToolUseDecision({
      decision: 'deny',
      reason: `Reva governance: could not determine which files "${input.tool_name}" would change, so it cannot be authorized.`,
    });
  }

  // Ingest-on-invoke — an MCP server being used but not yet ingested gets a
  // discovery pass triggered now instead of at the next recheck. Wrapped in
  // its own try/catch on purpose: main()'s catch below fails CLOSED, so an
  // unexpected throw in this best-effort bookkeeping would DENY a legitimate
  // tool call. Nothing here is worth blocking a user's work over, so it is
  // contained and swallowed rather than allowed to reach that handler.
  try {
    for (const mapping of toolMapping.mappings) {
      const mcpServer = (mapping.resourceParents || []).find((parent) => parent.type === 'MCPServer');
      if (mcpServer) triggerMcpIngestionForInvokedServer(mcpServer.id, input.cwd, pluginDataDir);
    }
  } catch (err: any) {
    debugLog(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
  }

  const turn = loadOrStartTurn(sessionId, pluginDataDir);
  // trace = this turn (shared by every call the prompt fans out into),
  // span = one resource of this tool call. The span key is tool_name +
  // tool_input + action + resource, which PostToolUse derives identically,
  // so each pre/post pair shares one span without either process having to
  // tell the other anything.
  // A subagent gets its own trace inside the parent's session; the main
  // agent's calls share the turn's trace (see trace.ts buildTraceId).
  const traceId = caller.isSubAgent
    ? buildTraceId(`subagent:${caller.subAgentId}`)
    : resolveTurnTraceId(sessionId, turn);
  // One span per resource: toolSpanKey adds action + resource, so several
  // resources of one call are separate pre/post pairs (see trace.ts).
  const traceparentFor = (mapping: { actionName: string; resourceId: string }): string =>
    traceparentHeader(traceId, deriveSpanId(traceId, toolSpanKey(input.tool_name, input.tool_input, mapping)));

  const spawnMapping = toolMapping.mappings.find((m) => m.actionName === 'spawn');
  const subagentIndex = spawnMapping ? nextSpawnIndex(sessionId, pluginDataDir) : undefined;

  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  const subjectDescriptor: CedarEntityDescriptor = caller.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${caller.agentId}:${caller.subAgentId}`, {
        agentType: caller.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', caller.agentId);
  const subject = refOf(subjectDescriptor);

  const hops: CedarHop[] = caller.hops;

  // The transmission describes this tool hop as the agent produced it: the
  // command, the search pattern, the raw patch text, or the serialized input.
  const firstMapping = toolMapping.mappings[0];
  const serializedInput = JSON.stringify(input.tool_input || {});
  const patchText = typeof input.tool_input?.raw === 'string' ? input.tool_input.raw.trim() : '';
  const currentHopContent =
    firstMapping.command?.trim() ||
    firstMapping.pattern?.trim() ||
    patchText ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);
  const transmission = buildTransmission(currentHopContent, 'assistant', input.tool_name);
  const conversationMessages = conversationFromTurn(turn);
  const session = directSessionFromTurn(sessionId, turn);
  const machineId = resolveMachineId(pluginDataDir);
  // The model behind this call: a Copilot subagent's own (subagent.configured
  // in the root session's record), otherwise the session's. See copilotModel.ts.
  const model = resolveCopilotModel({ sessionId, subAgentId: caller.isSubAgent ? caller.subAgentId : undefined });

  // One request per resource this tool call touches; only resource and the
  // per-action context differ, so the RTG sees N views of one action.
  const requests = toolMapping.mappings.map((mapping) => {
    const resourceDescriptor = buildEntityDescriptor(
      mapping.resourceType,
      mapping.resourceId,
      mapping.resourceProperties,
      mapping.resourceParents,
    );
    const request: CedarRequest = {
      subject: directSpecOf(subjectDescriptor),
      principal: directSpecOf(userDescriptor),
      action: { name: mapping.actionName },
      resource: directSpecOf(resourceDescriptor),
      context: buildActionContext(mapping, {
        subagentIndex,
        hops,
        conversationMessages,
        activeSessionCount,
        currentSession,
        machineId,
        model,
      }),
      transmission,
      session,
    };
    debugLog(
      `-> ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}${
        subagentIndex !== undefined ? `, subagentIndex=${subagentIndex}` : ''
      }, hops=${hops.length}${caller.isSubAgent ? `, subagent=${caller.subAgentId}` : ''}${model ? `, model=${model}` : ''})`,
    );
    return { mapping, request, traceparent: traceparentFor(mapping) };
  });

  if (spawnMapping) {
    const spawnHop: CedarHop = {
      seq: hops.length + 1,
      subject,
      action: { name: 'spawn' },
      resource: { type: spawnMapping.resourceType, id: spawnMapping.resourceId },
      time: new Date().toISOString(),
    };
    enqueuePendingSpawnLineage(caller.hopSessionId, hops, spawnHop, pluginDataDir);
  }

  // Commands that act through code (Add-Type, .NET file APIs, eval, …) are
  // asked about even when policy allows them — see indirectExecution.ts.
  const indirect = detectIndirectExecution(input.tool_name, firstMapping.command);
  if (indirect) debugLog(`-> indirect execution detected: ${indirect}`);
  const result = applyIndirectExecutionFloor(
    toHookResult(await evaluateAll(cfg, requests, pluginDataDir, sessionId)),
    indirect,
  );
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writePreToolUseDecision(result);
}

main().catch((err: any) => {
  // The ONLY record this denial leaves. writePreToolUseDecision exits the
  // process immediately after printing the hook response, so without this
  // line a fail-closed deny is invisible under REVA_DEBUG.
  debugLog(`PreToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  writePreToolUseDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  } satisfies RtgResult);
});
