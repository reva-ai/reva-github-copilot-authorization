"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const ingestionClient_1 = require("./ingestionClient");
const identity_1 = require("./identity");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const normalize_1 = require("./normalize");
const pluginData_1 = require("./pluginData");
const stdin_1 = require("./stdin");
// SessionStart has no blocking/decision control — but unlike a plain no-op,
// this hook deliberately waits for User/Agent ingestion before exiting:
// Cedar policies that check a STORED registration need that PATCH to have
// already landed. User and Agent run concurrently (different entities, no
// shared writes).
//
// MCP server discovery/ingestion is deliberately NOT part of this wait:
// it's spawned below as a fully detached, unref'd child — after the forced
// entity-type refresh, so that child reads the freshly-replaced cache.
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = (0, normalize_1.normalizeSessionStart)(JSON.parse(raw || '{}'));
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
    const agentId = (0, config_1.resolveConfiguredAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionStart: skipped active-session tracking — no Copilot account id and REVA_AGENT_ID not set');
    }
    else {
        try {
            (0, activeSessions_1.markSessionActive)(agentId, input.session_id, 
            // Environment only: the once-per-session parent-process check runs on
            // the first prompt or tool hook instead, outside this 10 s budget.
            (0, identity_1.resolveSessionEntrypointForSession)({
                agentId,
                sessionId: input.session_id,
                pluginDataDir,
                allowProcessLookup: false,
            }), pluginDataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
        }
    }
    try {
        const cfg = (0, config_1.loadConfig)();
        // Forced fresh fetch, replacing whatever's cached, once per session —
        // rather than only reacting after something has already failed against
        // a stale cached id. Done BEFORE spawning MCP ingestion below so that
        // detached child reads the freshly-replaced cache.
        const { userEntityTypeId, agentEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, pluginDataDir, true);
        // Started before the blocking work below so its own latency overlaps
        // with it instead of stacking on top of it. Unconditional, every
        // session — but still records the trigger time so a throttled
        // UserPromptSubmit recheck doesn't immediately re-trigger.
        (0, mcpIngestionTrigger_1.spawnMcpIngestion)(input.cwd || process.cwd(), pluginDataDir);
        (0, ingestionClient_1.recordMcpDiscoveryTriggered)(pluginDataDir);
        const userEmail = (0, identity_1.resolveUserEmail)();
        try {
            const tasks = [];
            if (!userEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped User ingestion — could not resolve entity type id');
            }
            else {
                const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
                tasks.push((0, ingestionClient_1.ingestUser)(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest User failed — ${err}`)));
            }
            if (!agentEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped Agent ingestion — could not resolve entity type id');
            }
            else {
                tasks.push((0, ingestionClient_1.ingestAgent)(cfg, agentEntityTypeId, cfg.agentId, userEmail, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest Agent failed — ${err}`)));
            }
            await Promise.all(tasks);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
