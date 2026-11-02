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
exports.slugifyMcpServerName = slugifyMcpServerName;
exports.isMcpServerUuid = isMcpServerUuid;
exports.loadMcpServerIdentityCache = loadMcpServerIdentityCache;
exports.refreshMcpServerIdentityCache = refreshMcpServerIdentityCache;
exports.resolveMcpServerIdentity = resolveMcpServerIdentity;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// One identifier for an MCP server, shared by discovery (mcpDiscovery.ts)
// and enforcement (mapping.ts). The canonical id is a slug derived from the
// server's DISPLAY name — "Google Calendar" -> google-calendar. Both sides
// converge on it: discovery slugifies the names it reads from disk, and
// enforcement slugifies the server token in the tool name the same way.
//
// Slugging applies to EVERYTHING — display names and machine tokens alike.
// A .mcp.json key and the non-uuid half of an mcp__<server>__<tool> name all
// go through the same function, so one id format holds across every source.
//
// Copilot has no desktop-app session files to scan for a uuid → display-name
// mapping, so refreshMcpServerIdentityCache is a no-op that returns empty;
// resolve still slugifies non-uuid tokens and can read a cache if one were
// ever written elsewhere.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only these two connector-name prefixes are stripped, so a .mcp.json entry
// that uses one resolves to the same slug as the bare name.
const CLAUDE_AI_PREFIX = /^claude\.ai\s+|^claude_ai_/i;
function slugifyMcpServerName(raw) {
    if (typeof raw !== 'string')
        return '';
    const stripped = raw.replace(CLAUDE_AI_PREFIX, '');
    // A name that is ENTIRELY the prefix ("claude.ai ") would strip to nothing
    // — keep the original in that case rather than returning an empty id.
    const base = stripped.trim().length > 0 ? stripped : raw;
    return base
        .toLowerCase()
        .replace(/[\s._]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}
function isMcpServerUuid(token) {
    return typeof token === 'string' && UUID_PATTERN.test(token);
}
function identityCachePath(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'mcp-server-identity.json') : undefined;
}
function loadMcpServerIdentityCache(pluginDataDir) {
    const file = identityCachePath(pluginDataDir);
    if (!file)
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
// No-op on Copilot: there is no desktop session-file source to scan. Returns
// whatever is already cached (usually empty) without writing.
function refreshMcpServerIdentityCache(pluginDataDir) {
    return loadMcpServerIdentityCache(pluginDataDir);
}
// Invoke-time resolution of the server token in an mcp__<server>__<tool>
// (or mcp/<server>/<tool>) name. A uuid is looked up in the cache; anything
// else is slugified directly.
//
// On a cache MISS for a uuid the raw token is returned unchanged —
// deliberately never a fabricated slug. A uuid carries no name, so there is
// nothing honest to derive from it.
function resolveMcpServerIdentity(token, pluginDataDir) {
    if (!isMcpServerUuid(token)) {
        return { slug: slugifyMcpServerName(token) || token };
    }
    const uuid = token.toLowerCase();
    const cached = loadMcpServerIdentityCache(pluginDataDir)[uuid];
    if (cached && typeof cached.slug === 'string' && cached.slug.length > 0)
        return cached;
    return { slug: uuid, uuid };
}
