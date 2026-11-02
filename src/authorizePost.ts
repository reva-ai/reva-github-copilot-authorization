import { getActiveSessionCount, getSessionEntry } from './activeSessions';
import { buildActionContext, buildToolResponseTransmission } from './context';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveCopilotModel } from './copilotModel';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf } from './entity';
import { evaluateAll, toHookResult } from './evaluateAll';
import { writePostToolUseDecision } from './hookOutput';
import { resolveCaller, resolveUserEmail } from './identity';
import { mapToolCall } from './mapping';
import { normalizePostToolUse } from './normalize';
import { resolvePluginDataDir } from './pluginData';
import { readStdin } from './stdin';
import { buildTraceId, deriveSpanId, toolSpanKey, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarRequest, RtgResult } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId } from './turnCache';

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = normalizePostToolUse(JSON.parse(raw));
  const cfg = loadConfig();
  const pluginDataDir = resolvePluginDataDir();

  // See authorize.ts: a Copilot subagent's calls are attributed to the
  // user's root session, with the SubAgent subject and its bound lineage.
  const caller = resolveCaller(cfg.agentId, input, pluginDataDir);
  const sessionId = caller.sessionId;

  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);
  const currentSession = getSessionEntry(cfg.agentId, sessionId, pluginDataDir);

  const toolMapping = mapToolCall(input.tool_name, input.tool_input || {}, input.cwd);

  // PreToolUse already denied a patch whose files could not be determined, so
  // this only happens if the host ran it anyway; nothing identifiable to
  // evaluate, and PostToolUse cannot undo the tool.
  if (toolMapping.mappings.length === 0) {
    debugLog(`-> post ${input.tool_name}: no resources could be evaluated — nothing to do`);
    process.exit(0);
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

  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  const subjectDescriptor: CedarEntityDescriptor = caller.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${caller.agentId}:${caller.subAgentId}`, {
        agentType: caller.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', caller.agentId);

  const hops = caller.hops;

  // Same current-hop prompt PreToolUse puts in transmission.userQuery.
  const firstMapping = toolMapping.mappings[0];
  const serializedInput = JSON.stringify(input.tool_input || {});
  const patchText = typeof input.tool_input?.raw === 'string' ? input.tool_input.raw.trim() : '';
  const currentHopContent =
    firstMapping.command?.trim() ||
    firstMapping.pattern?.trim() ||
    patchText ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);
  // userQuery matches PreToolUse; the tool result is transmission.response,
  // not closed Cedar context, so the evaluate payload carries it without a
  // schema change.
  const transmission = buildToolResponseTransmission(input.tool_response, currentHopContent);
  const conversationMessages = conversationFromTurn(turn);
  const session = directSessionFromTurn(sessionId, turn);
  const machineId = resolveMachineId(pluginDataDir);
  // The model behind this call: a Copilot subagent's own (subagent.configured
  // in the root session's record), otherwise the session's. See copilotModel.ts.
  const model = resolveCopilotModel({ sessionId, subAgentId: caller.isSubAgent ? caller.subAgentId : undefined });

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
        hops,
        conversationMessages,
        activeSessionCount,
        currentSession,
        machineId,
        model,
        modelContext: cfg.modelContext,
      }),
      transmission,
      session,
    };
    debugLog(
      `-> post ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}, hops=${hops.length}${
        caller.isSubAgent ? `, subagent=${caller.subAgentId}` : ''
      })`,
    );
    return { mapping, request, traceparent: traceparentFor(mapping) };
  });

  const result = toHookResult(await evaluateAll(cfg, requests, pluginDataDir, sessionId));
  debugLog(`<- post decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writePostToolUseDecision(result);
}

main().catch((err: any) => {
  debugLog(`PostToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  writePostToolUseDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  } satisfies RtgResult);
});
