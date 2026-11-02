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
exports.markSessionActive = markSessionActive;
exports.recordSessionEditor = recordSessionEditor;
exports.getActiveSessions = getActiveSessions;
exports.getActiveSessionCount = getActiveSessionCount;
exports.getSessionEntry = getSessionEntry;
exports.markSessionInactive = markSessionInactive;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const ACTIVE_TTL_MS = 10 * 60 * 1000; // no activity for 10 minutes ⇒ treated as gone
// No fallback: only ever writes inside COPILOT_PLUGIN_DATA (also aliased as
// PLUGIN_DATA / CLAUDE_PLUGIN_DATA — see pluginData.ts). Without it, there
// is nothing honest to write to, so every function below just no-ops/returns
// an empty result rather than inventing a location of its own.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'active-sessions') : undefined;
}
function cacheFile(agentId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function loadState(agentId, pluginDataDir) {
    const file = cacheFile(agentId, pluginDataDir);
    if (!file)
        return { sessions: {} };
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
    }
    catch {
        return { sessions: {} };
    }
}
function saveState(agentId, state, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(agentId, pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort — the next call just tries again
    }
}
// Drops any entry not seen within ACTIVE_TTL_MS — called on every write so
// the file can't accumulate sessions that closed hours/days ago.
function pruneStale(state) {
    const now = Date.now();
    const sessions = {};
    for (const [sessionId, entry] of Object.entries(state.sessions)) {
        if (now - entry.lastSeen < ACTIVE_TTL_MS) {
            sessions[sessionId] = entry;
        }
    }
    return { sessions };
}
// Registers (or refreshes) this session as active, and returns the entry
// just written — callers use this directly for the current session's own
// context fields (sessionId/sessionEntryPoint/sessionLastSeen), no separate
// read needed. Called from SessionStart (first sight of a session) and
// PreToolUse/UserPromptSubmit (keeps lastSeen current for as long as the
// session keeps being used). See markSessionInactive below for the
// counterpart that removes an entry on SessionEnd. Returns undefined for
// an empty/missing sessionId — nothing honest to record (avoids a literal
// "undefined" key) or report.
function markSessionActive(agentId, sessionId, entrypoint, pluginDataDir) {
    if (!sessionId)
        return undefined;
    const state = pruneStale(loadState(agentId, pluginDataDir));
    const previous = state.sessions[sessionId];
    const entry = {
        entrypoint,
        lastSeen: Date.now(),
        ...(previous?.editorFromProcess !== undefined ? { editorFromProcess: previous.editorFromProcess } : {}),
    };
    state.sessions[sessionId] = entry;
    saveState(agentId, state, pluginDataDir);
    return { sessionId, ...entry };
}
// Saves the result of identity.ts's parent-process walk for this session, so
// later hooks reuse it instead of walking again.
function recordSessionEditor(agentId, sessionId, editor, pluginDataDir) {
    if (!sessionId)
        return;
    const state = pruneStale(loadState(agentId, pluginDataDir));
    const previous = state.sessions[sessionId];
    state.sessions[sessionId] = {
        entrypoint: previous?.entrypoint ?? '',
        lastSeen: previous?.lastSeen ?? Date.now(),
        editorFromProcess: editor,
    };
    saveState(agentId, state, pluginDataDir);
}
// Every session currently considered active for this Agent's local
// registry (keyed by agentId, but the underlying file always lives on
// exactly one machine regardless of what agentId itself represents),
// including the caller's own — so 1 means only this session is active, 2+
// means at least one other tab/window/app is also running right now.
function getActiveSessions(agentId, pluginDataDir) {
    const state = pruneStale(loadState(agentId, pluginDataDir));
    return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}
function getActiveSessionCount(agentId, pluginDataDir) {
    return getActiveSessions(agentId, pluginDataDir).length;
}
// Read-only lookup of one session's own entry, without refreshing it —
// used by PostToolUse, where PreToolUse already refreshed lastSeen moments
// earlier in the same tool-call cycle.
function getSessionEntry(agentId, sessionId, pluginDataDir) {
    return getActiveSessions(agentId, pluginDataDir).find((s) => s.sessionId === sessionId);
}
// Explicit removal, called from SessionEnd (sessionEnd.ts) when it fires —
// the one non-TTL way an entry leaves this file. SessionEnd isn't
// guaranteed to fire on an abrupt termination (killed process, closed
// terminal) — the TTL above stays as the fallback for exactly that gap;
// this is just the fast path for a graceful one, so a session doesn't
// linger as "active" for up to ACTIVE_TTL_MS after it's actually gone.
function markSessionInactive(agentId, sessionId, pluginDataDir) {
    if (!sessionId)
        return;
    const state = pruneStale(loadState(agentId, pluginDataDir));
    if (sessionId in state.sessions) {
        delete state.sessions[sessionId];
        saveState(agentId, state, pluginDataDir);
    }
}
