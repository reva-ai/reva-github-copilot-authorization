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
const hookOutput_1 = require("./hookOutput");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const normalize_1 = require("./normalize");
const pluginData_1 = require("./pluginData");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = (0, normalize_1.normalizePostToolUse)(JSON.parse(raw));
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
    // See authorize.ts: a Copilot subagent's calls are attributed to the
    // user's root session, with the SubAgent subject and its bound lineage.
    const caller = (0, identity_1.resolveCaller)(cfg.agentId, input, pluginDataDir);
    const sessionId = caller.sessionId;
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const currentSession = (0, activeSessions_1.getSessionEntry)(cfg.agentId, sessionId, pluginDataDir);
    // Same session ids as authorize.ts, so an MCP call maps to the same
    // Tool + MCPServer resource as its PreToolUse request.
    const toolMapping = (0, mapping_1.mapToolCall)(input.tool_name, input.tool_input || {}, input.cwd, {
        sessionIds: [input.session_id, sessionId],
    });
    // PreToolUse already denied a patch whose files could not be determined, so
    // this only happens if the host ran it anyway; nothing identifiable to
    // evaluate, and PostToolUse cannot undo the tool.
    if (toolMapping.mappings.length === 0) {
        (0, debug_1.debugLog)(`-> post ${input.tool_name}: no resources could be evaluated — nothing to do`);
        process.exit(0);
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
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    const subjectDescriptor = caller.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${caller.agentId}:${caller.subAgentId}`, {
            agentType: caller.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', caller.agentId);
    const hops = caller.hops;
    // Same current-hop prompt PreToolUse puts in transmission.userQuery.
    const firstMapping = toolMapping.mappings[0];
    const serializedInput = JSON.stringify(input.tool_input || {});
    const patchText = typeof input.tool_input?.raw === 'string' ? input.tool_input.raw.trim() : '';
    const currentHopContent = firstMapping.command?.trim() ||
        firstMapping.pattern?.trim() ||
        patchText ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    // userQuery matches PreToolUse; the tool result is transmission.response,
    // not closed Cedar context, so the evaluate payload carries it without a
    // schema change.
    const transmission = (0, context_1.buildToolResponseTransmission)(input.tool_response, currentHopContent);
    const conversationMessages = (0, turnCache_1.conversationFromTurn)(turn);
    const session = (0, turnCache_1.directSessionFromTurn)(sessionId, turn);
    const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
    // The model behind this call: a Copilot subagent's own (subagent.configured
    // in the root session's record), otherwise the session's. See copilotModel.ts.
    const model = (0, copilotModel_1.resolveCopilotModel)({ sessionId, subAgentId: caller.isSubAgent ? caller.subAgentId : undefined });
    const requests = toolMapping.mappings.map((mapping) => {
        const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: mapping.actionName },
            resource: (0, entity_1.directSpecOf)(resourceDescriptor),
            context: (0, context_1.buildActionContext)(mapping, {
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
        (0, debug_1.debugLog)(`-> post ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}, hops=${hops.length}${caller.isSubAgent ? `, subagent=${caller.subAgentId}` : ''})`);
        return { mapping, request, traceparent: traceparentFor(mapping) };
    });
    const result = (0, evaluateAll_1.toHookResult)(await (0, evaluateAll_1.evaluateAll)(cfg, requests, pluginDataDir, sessionId));
    (0, debug_1.debugLog)(`<- post decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    (0, hookOutput_1.writePostToolUseDecision)(result);
}
main().catch((err) => {
    (0, debug_1.debugLog)(`PostToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.writePostToolUseDecision)({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
