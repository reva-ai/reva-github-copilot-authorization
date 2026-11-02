"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const debug_1 = require("./debug");
const config_1 = require("./config");
const pluginData_1 = require("./pluginData");
const stdin_1 = require("./stdin");
const subAgentRegistry_1 = require("./subAgentRegistry");
function pickSessionId(input) {
    const id = input.sessionId ?? input.session_id;
    return typeof id === 'string' && id.length > 0 ? id : '';
}
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw || '{}');
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
    // Drop this session's subagent registrations (subAgentRegistry.ts) — pure
    // local cleanup, no identity needed.
    try {
        (0, subAgentRegistry_1.removeSubAgentsOfSession)(pickSessionId(input), pluginDataDir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionEnd: removeSubAgentsOfSession failed — ${err?.message || String(err)}`);
    }
    // Cache only: no gh process inside Copilot's ~1.5s SessionEnd budget.
    const agentId = (0, config_1.resolveConfiguredAgentId)(process.env, undefined, { allowLookup: false });
    if (!agentId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no cached Copilot account id and REVA_AGENT_ID not set');
    }
    else {
        try {
            (0, activeSessions_1.markSessionInactive)(agentId, pickSessionId(input), pluginDataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
        }
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
