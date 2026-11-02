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
exports.registerSubAgent = registerSubAgent;
exports.resolveSubAgent = resolveSubAgent;
exports.removeSubAgentsOfSession = removeSubAgentsOfSession;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Guards the parent walk against a cyclic or absurdly deep registry.
const MAX_DEPTH = 16;
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'subagents') : undefined;
}
function cacheFile(sessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
function loadEntry(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return undefined;
    try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        return entry && typeof entry.parentSessionId === 'string' ? entry : undefined;
    }
    catch {
        return undefined;
    }
}
// Keyed by the sessionId the subagent's later hooks will arrive with.
function registerSubAgent(sessionId, entry, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    }
    catch {
        // best effort — the subagent's calls just fall back to top-level handling
    }
}
// Returns the registered subagent for this hook's sessionId, with its root
// session resolved, or undefined for a top-level session.
function resolveSubAgent(sessionId, pluginDataDir) {
    const entry = loadEntry(sessionId, pluginDataDir);
    if (!entry)
        return undefined;
    let rootSessionId = entry.parentSessionId;
    const seen = new Set([sessionId]);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        if (seen.has(rootSessionId))
            break;
        seen.add(rootSessionId);
        const parent = loadEntry(rootSessionId, pluginDataDir);
        if (!parent)
            break;
        rootSessionId = parent.parentSessionId;
    }
    return { ...entry, rootSessionId };
}
// Called from sessionEnd for the top-level session: drops every subagent
// entry whose root is that session, so the directory doesn't grow forever.
function removeSubAgentsOfSession(rootSessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir || !rootSessionId)
        return;
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    // Resolve every root first, then delete: removing a child before its
    // grandchild is resolved would cut the grandchild's walk short.
    const doomed = names.filter((name) => {
        if (!name.endsWith('.json'))
            return false;
        const resolved = resolveSubAgent(name.slice(0, -'.json'.length), pluginDataDir);
        return resolved?.rootSessionId === rootSessionId;
    });
    for (const name of doomed) {
        try {
            fs.rmSync(path.join(dir, name), { force: true });
        }
        catch {
            // best effort
        }
    }
}
