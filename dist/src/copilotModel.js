"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCopilotHome = resolveCopilotHome;
exports.readEvents = readEvents;
exports.resolveCopilotModel = resolveCopilotModel;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// Which model Copilot CLI is running for a session. Copilot's hook payloads
// carry no model field, so it is read from the session record Copilot itself
// writes:
//
//   $COPILOT_HOME/session-state/<sessionId>/events.jsonl   (default ~/.copilot)
//
// Event shapes as written by CLI 1.0.103:
//   session.model_change        data.newModel     — an explicit model, or "auto"
//   session.auto_mode_resolved  data.chosenModel  — what Auto picked
//   subagent.configured         agentId + data.model — a subagent's model
//   session.start               data.selectedModel — the model a VS Code
//                               Copilot Chat session starts with; those
//                               sessions write no model_change at all
//
// The most recent applicable event wins (a /model switch mid-session
// replaces the earlier one); session.start is the first line, so its
// selectedModel only counts when nothing later names a model. "auto" alone
// is not a model, so it never resolves to anything by itself. The per-event
// `model` field is never used: it includes helper models (e.g. the one that
// writes chat titles). Nothing found → undefined; never guessed.
const MODEL_CHANGE = '"session.model_change"';
const AUTO_RESOLVED = '"session.auto_mode_resolved"';
const SESSION_START = '"session.start"';
const SUBAGENT_CONFIGURED = '"subagent.configured"';
function resolveCopilotHome(env = process.env) {
    return env.COPILOT_HOME?.trim() || path.join(os.homedir(), '.copilot');
}
// Shared with copilotMcp.ts, which reads the same record for MCP calls.
function readEvents(sessionId, copilotHome) {
    if (!sessionId)
        return [];
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
        return fs.readFileSync(path.join(copilotHome, 'session-state', safe, 'events.jsonl'), 'utf8').split('\n');
    }
    catch {
        return [];
    }
}
function parse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
function resolveCopilotModel(opts) {
    const lines = readEvents(opts.sessionId, opts.copilotHome || resolveCopilotHome());
    if (opts.subAgentId) {
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes(SUBAGENT_CONFIGURED) || !lines[i].includes(opts.subAgentId))
                continue;
            const e = parse(lines[i]);
            if (e?.type === 'subagent.configured' && e.agentId === opts.subAgentId && typeof e.data?.model === 'string') {
                return e.data.model;
            }
        }
        // Not configured with its own model: it runs on the session's model.
    }
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes(AUTO_RESOLVED)) {
            const e = parse(line);
            const chosen = e?.data?.chosenModel;
            if (e?.type === 'session.auto_mode_resolved' && typeof chosen === 'string' && chosen)
                return chosen;
        }
        else if (line.includes(MODEL_CHANGE)) {
            const e = parse(line);
            const model = e?.data?.newModel;
            if (e?.type !== 'session.model_change' || typeof model !== 'string' || !model)
                continue;
            // An explicit model is the answer. "auto" means the concrete model is
            // only known from a later auto_mode_resolved — which the backward scan
            // would already have returned had one existed.
            if (model.toLowerCase() !== 'auto')
                return model;
            return undefined;
        }
        else if (line.includes(SESSION_START)) {
            const e = parse(line);
            const selected = e?.data?.selectedModel;
            if (e?.type !== 'session.start' || typeof selected !== 'string' || !selected)
                continue;
            return selected.toLowerCase() !== 'auto' ? selected : undefined;
        }
    }
    return undefined;
}
