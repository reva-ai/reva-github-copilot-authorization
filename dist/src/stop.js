"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assistantOutput_1 = require("./assistantOutput");
const config_1 = require("./config");
const debug_1 = require("./debug");
const normalize_1 = require("./normalize");
const pluginData_1 = require("./pluginData");
const rtgCircuitBreaker_1 = require("./rtgCircuitBreaker");
const rtgClient_1 = require("./rtgClient");
const stdin_1 = require("./stdin");
const subAgentRegistry_1 = require("./subAgentRegistry");
const turnCache_1 = require("./turnCache");
// Copilot CLI's agentStop (VS Code Copilot Chat's Stop) fires when the main
// agent finishes a turn. That is the natural close of one prompt trace: the
// evaluate calls already gave Reva the hops; summarize asks Reva to write the
// trace summary. Best-effort — a failed summarize must never block or alter
// Copilot, so this hook writes nothing to stdout (any decision output would
// be read as `block`, which forces another turn) and always exits 0.
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = (0, normalize_1.normalizeStop)(JSON.parse(raw || '{}'));
    const pluginDataDir = (0, pluginData_1.resolvePluginDataDir)();
    try {
        // agentStop is the main agent's turn; a registered subagent session has
        // no turn of its own to close.
        if ((0, subAgentRegistry_1.resolveSubAgent)(input.session_id, pluginDataDir)) {
            (0, debug_1.debugLog)('stop: skip summarize — sub-agent session');
            process.exit(0);
        }
        // After a 401 the plugin stops calling Reva for the rest of the session.
        if ((0, rtgCircuitBreaker_1.isCircuitOpen)(input.session_id, pluginDataDir).open) {
            (0, debug_1.debugLog)('stop: skip summarize — circuit open for this session');
            process.exit(0);
        }
        const cfg = (0, config_1.loadConfig)();
        const turn = (0, turnCache_1.loadTurn)(input.session_id, pluginDataDir);
        if (!turn) {
            (0, debug_1.debugLog)('stop: skip summarize — no turn cache entry');
            process.exit(0);
        }
        // Copilot's agentStop payload carries a transcript path, not the reply
        // itself, so `output` is only sent when the host supplies the reply.
        const output = (0, assistantOutput_1.truncateAssistantOutput)(input.last_assistant_message);
        if (!output)
            (0, debug_1.debugLog)('stop: no assistant output in the hook input — summarizing without it');
        const traceId = (0, turnCache_1.resolveTurnTraceId)(input.session_id, turn);
        const result = await (0, rtgClient_1.summarizeTrace)(cfg, {
            trace_id: traceId,
            thread_id: input.session_id,
            ...(output ? { output } : {}),
        });
        if (result.ok) {
            (0, debug_1.debugLog)(`stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output, 'utf8')}`);
        }
        else {
            (0, debug_1.debugLog)(`stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`stop: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
