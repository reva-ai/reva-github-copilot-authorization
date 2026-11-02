"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const context_1 = require("./context");
const config_1 = require("./config");
const debug_1 = require("./debug");
const copilotModel_1 = require("./copilotModel");
const deviceId_1 = require("./deviceId");
const entity_1 = require("./entity");
const evaluateAll_1 = require("./evaluateAll");
const indirectExecution_1 = require("./indirectExecution");
const hopChain_1 = require("./hopChain");
const hookOutput_1 = require("./hookOutput");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const normalize_1 = require("./normalize");
const pluginData_1 = require("./pluginData");
const stdin_1 = require("./stdin");
const spawnCounter_1 = require("./spawnCounter");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = (0, normalize_1.normalizePreToolUse)(JSON.parse(raw));
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
    // A Copilot subagent's calls arrive under its own sessionId; caller.sessionId
    // is the user's root session, which every session-scoped value below uses.
    const caller = (0, identity_1.resolveCaller)(cfg.agentId, input, pluginDataDir);
    const sessionId = caller.sessionId;
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, sessionId, (0, identity_1.resolveSessionEntrypointForSession)({ agentId: cfg.agentId, sessionId, pluginDataDir }), pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const toolMapping = (0, mapping_1.mapToolCall)(input.tool_name, input.tool_input || {}, input.cwd);
    // A shell command naming more distinct paths than one call evaluates:
    // denied rather than evaluated partially or widened to a common ancestor,
    // either of which would let a narrower path policy be bypassed.
    if (toolMapping.overCap) {
        (0, debug_1.debugLog)(`-> ${input.tool_name}: ${toolMapping.candidateCount} paths — over the per-call limit, denied`);
        (0, hookOutput_1.writePreToolUseDecision)({
            decision: 'deny',
            reason: `Reva governance: this command touches ${toolMapping.candidateCount} distinct paths, more than can be authorized in one call. Split it into smaller commands.`,
        });
    }
    // No identifiable resource. Only apply_patch can get here (every other tool
    // falls back to a concrete resource): its envelope named no file, and a
    // mutation whose target is unknown must not pass silently.
    if (toolMapping.mappings.length === 0) {
        (0, debug_1.debugLog)(`-> ${input.tool_name}: no resources could be determined — failing closed`);
        (0, hookOutput_1.writePreToolUseDecision)({
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
            if (mcpServer)
                (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)(mcpServer.id, input.cwd, pluginDataDir);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
    }
    const turn = (0, turnCache_1.loadOrStartTurn)(sessionId, pluginDataDir);
    // trace = this turn (shared by every call the prompt fans out into),
    // span = one resource of this tool call. The span key is tool_name +
    // tool_input + action + resource, which PostToolUse derives identically,
    // so each pre/post pair shares one span without either process having to
    // tell the other anything.
    // A subagent gets its own trace inside the parent's session; the main
    // agent's calls share the turn's trace (see trace.ts buildTraceId).
    const traceId = caller.isSubAgent
        ? (0, trace_1.buildTraceId)(`subagent:${caller.subAgentId}`)
        : (0, turnCache_1.resolveTurnTraceId)(sessionId, turn);
    // One span per resource: toolSpanKey adds action + resource, so several
    // resources of one call are separate pre/post pairs (see trace.ts).
    const traceparentFor = (mapping) => (0, trace_1.traceparentHeader)(traceId, (0, trace_1.deriveSpanId)(traceId, (0, trace_1.toolSpanKey)(input.tool_name, input.tool_input, mapping)));
    const spawnMapping = toolMapping.mappings.find((m) => m.actionName === 'spawn');
    const subagentIndex = spawnMapping ? (0, spawnCounter_1.nextSpawnIndex)(sessionId, pluginDataDir) : undefined;
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    const subjectDescriptor = caller.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${caller.agentId}:${caller.subAgentId}`, {
            agentType: caller.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', caller.agentId);
    const subject = (0, entity_1.refOf)(subjectDescriptor);
    const hops = caller.hops;
    // The transmission describes this tool hop as the agent produced it: the
    // command, the search pattern, the raw patch text, or the serialized input.
    const firstMapping = toolMapping.mappings[0];
    const serializedInput = JSON.stringify(input.tool_input || {});
    const patchText = typeof input.tool_input?.raw === 'string' ? input.tool_input.raw.trim() : '';
    const currentHopContent = firstMapping.command?.trim() ||
        firstMapping.pattern?.trim() ||
        patchText ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    const transmission = (0, context_1.buildTransmission)(currentHopContent, 'assistant', input.tool_name);
    const conversationMessages = (0, turnCache_1.conversationFromTurn)(turn);
    const session = (0, turnCache_1.directSessionFromTurn)(sessionId, turn);
    const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
    // The model behind this call: a Copilot subagent's own (subagent.configured
    // in the root session's record), otherwise the session's. See copilotModel.ts.
    const model = (0, copilotModel_1.resolveCopilotModel)({ sessionId, subAgentId: caller.isSubAgent ? caller.subAgentId : undefined });
    // One request per resource this tool call touches; only resource and the
    // per-action context differ, so the RTG sees N views of one action.
    const requests = toolMapping.mappings.map((mapping) => {
        const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: mapping.actionName },
            resource: (0, entity_1.directSpecOf)(resourceDescriptor),
            context: (0, context_1.buildActionContext)(mapping, {
                subagentIndex,
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
        (0, debug_1.debugLog)(`-> ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}${subagentIndex !== undefined ? `, subagentIndex=${subagentIndex}` : ''}, hops=${hops.length}${caller.isSubAgent ? `, subagent=${caller.subAgentId}` : ''}${model ? `, model=${model}` : ''})`);
        return { mapping, request, traceparent: traceparentFor(mapping) };
    });
    if (spawnMapping) {
        const spawnHop = {
            seq: hops.length + 1,
            subject,
            action: { name: 'spawn' },
            resource: { type: spawnMapping.resourceType, id: spawnMapping.resourceId },
            time: new Date().toISOString(),
        };
        (0, hopChain_1.enqueuePendingSpawnLineage)(caller.hopSessionId, hops, spawnHop, pluginDataDir);
    }
    // Commands that act through code (Add-Type, .NET file APIs, eval, …) are
    // asked about even when policy allows them — see indirectExecution.ts.
    const indirect = (0, indirectExecution_1.detectIndirectExecution)(input.tool_name, firstMapping.command);
    if (indirect)
        (0, debug_1.debugLog)(`-> indirect execution detected: ${indirect}`);
    const result = (0, indirectExecution_1.applyIndirectExecutionFloor)((0, evaluateAll_1.toHookResult)(await (0, evaluateAll_1.evaluateAll)(cfg, requests, pluginDataDir, sessionId)), indirect);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    (0, hookOutput_1.writePreToolUseDecision)(result);
}
main().catch((err) => {
    // The ONLY record this denial leaves. writePreToolUseDecision exits the
    // process immediately after printing the hook response, so without this
    // line a fail-closed deny is invisible under REVA_DEBUG.
    (0, debug_1.debugLog)(`PreToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.writePreToolUseDecision)({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
