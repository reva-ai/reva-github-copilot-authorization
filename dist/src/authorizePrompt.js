"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const copilotModel_1 = require("./copilotModel");
const deviceId_1 = require("./deviceId");
const hopChain_1 = require("./hopChain");
const hookOutput_1 = require("./hookOutput");
const identity_1 = require("./identity");
const ingestionClient_1 = require("./ingestionClient");
const invokeAgent_1 = require("./invokeAgent");
const normalize_1 = require("./normalize");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const rtgClient_1 = require("./rtgClient");
const pluginData_1 = require("./pluginData");
const spawnCounter_1 = require("./spawnCounter");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const subAgentRegistry_1 = require("./subAgentRegistry");
const turnCache_1 = require("./turnCache");
function registerSubAgentKickoff(input, pluginDataDir) {
    const parentSessionId = input.parent_agent_id;
    const subAgentId = input.agent_id;
    // Spawns and kickoffs happen in the same order, so the oldest lineage the
    // parent queued is this child's. If none is queued (the spawn's own hook
    // failed or predates this plugin version), fall back to the parent's
    // known chain rather than inventing a spawn hop.
    const parent = (0, subAgentRegistry_1.resolveSubAgent)(parentSessionId, pluginDataDir);
    let lineage = (0, hopChain_1.resolveSubAgentLineage)(parentSessionId, subAgentId, pluginDataDir);
    if (lineage.length === 0) {
        lineage = parent ? parent.lineage : (0, hopChain_1.loadAgentHops)(parentSessionId, pluginDataDir);
    }
    (0, subAgentRegistry_1.registerSubAgent)(input.session_id, {
        subAgentId,
        parentSessionId,
        agentType: input.agent_type || 'subagent',
        lineage,
        registeredAt: new Date().toISOString(),
    }, pluginDataDir);
    (0, debug_1.debugLog)(`-> subagent kickoff ${subAgentId} (type=${input.agent_type || 'subagent'}, parent=${parentSessionId}, hops=${lineage.length}) — not evaluated; gated by the parent's spawn`);
}
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = (0, normalize_1.normalizeUserPrompt)(JSON.parse(raw));
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
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
    const cfg = (0, config_1.loadConfig)();
    // Closes the gap between SessionStart's once-per-session discovery pass
    // and a connector added mid-session: userPromptSubmitted fires every turn,
    // so re-checking here (throttled to ~15 minutes, see
    // mcpIngestionTrigger.ts) picks up a new connector well before the next
    // SessionStart would. A no-op, non-blocking cache read when not yet due.
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)(input.cwd, pluginDataDir);
    const userEmail = (0, identity_1.resolveUserEmail)();
    const prompt = input.prompt ? (0, turnCache_1.truncatePrompt)(input.prompt) : '';
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.session_id, (0, identity_1.resolveSessionEntrypointForSession)({ agentId: cfg.agentId, sessionId: input.session_id, pluginDataDir }), pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const turn = (0, turnCache_1.startTurn)(input.session_id, input.prompt, pluginDataDir);
    (0, spawnCounter_1.resetSpawnCounter)(input.session_id, pluginDataDir);
    // This hook opens the turn, so its trace id is the one every tool call in
    // the turn will read back. Its own span is the prompt evaluation itself.
    const traceId = (0, turnCache_1.resolveTurnTraceId)(input.session_id, turn);
    const spanId = (0, trace_1.deriveSpanId)(traceId, 'user-prompt');
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, traceId, input.prompt_id);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    // Always evaluate invokeAgent for hops + audit. Copilot command hooks for
    // userPromptSubmitted often cannot block the turn — preToolUse is the
    // real enforcement gate (see hookOutput.writePromptDecision).
    // The model Copilot routed this prompt to (Auto resolves it before this
    // hook fires). Read from Copilot's own session record — see copilotModel.ts.
    const model = (0, copilotModel_1.resolveCopilotModel)({ sessionId: input.session_id });
    const request = (0, invokeAgent_1.buildInvokeAgentRequest)(userEmail, cfg.agentId, prompt || '(empty prompt)', (0, turnCache_1.directSessionFromTurn)(input.session_id, turn), activeSessionCount, currentSession, (0, deviceId_1.resolveMachineId)(pluginDataDir), { model, modelContext: cfg.modelContext });
    (0, debug_1.debugLog)(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId}${model ? ` (model=${model})` : ''}`);
    // Agent.models is recorded alongside the evaluation, not before it, so a
    // new model adds no latency to the prompt. Best-effort; never throws.
    const [result] = await Promise.all([
        (0, rtgClient_1.evaluate)(cfg, request, traceparent, pluginDataDir, input.session_id),
        (0, ingestionClient_1.recordAgentModel)(cfg, cfg.agentId, model, pluginDataDir),
    ]);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    const invokeAgentHop = {
        seq: 1,
        subject: request.subject,
        action: { name: 'invokeAgent' },
        resource: request.resource,
        time: new Date().toISOString(),
    };
    (0, hopChain_1.startTurnHops)(input.session_id, invokeAgentHop, pluginDataDir);
    (0, hookOutput_1.writePromptDecision)(result);
}
main().catch((err) => {
    (0, debug_1.debugLog)(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.writePromptDecision)({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
