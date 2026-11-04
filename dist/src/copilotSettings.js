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
exports.resolveCopilotSettingsPath = resolveCopilotSettingsPath;
exports.readCopilotJsonc = readCopilotJsonc;
exports.readDisabledMcpServers = readDisabledMcpServers;
exports.readCopilotSettingsReva = readCopilotSettingsReva;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// Copilot settings.json is JSONC. Strip // and /* */ comments before JSON.parse.
function stripJsonc(raw) {
    let out = '';
    let i = 0;
    let inString = false;
    let escape = false;
    while (i < raw.length) {
        const c = raw[i];
        const next = raw[i + 1];
        if (inString) {
            out += c;
            if (escape)
                escape = false;
            else if (c === '\\')
                escape = true;
            else if (c === '"')
                inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && next === '/') {
            i += 2;
            while (i < raw.length && raw[i] !== '\n')
                i++;
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
function resolveCopilotSettingsPath() {
    return path.join(os.homedir(), '.copilot', 'settings.json');
}
// Parses a Copilot JSON/JSONC file; undefined when missing or malformed.
function readCopilotJsonc(file) {
    try {
        const parsed = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
// MCP servers turned off with `copilot mcp disable <name>`. As of CLI
// 1.0.97 the name is appended to settings.json `disabledMcpServers` and
// removed again by `copilot mcp enable` (mcp-config.json is left untouched).
function readDisabledMcpServers(settingsPath) {
    const list = readCopilotJsonc(settingsPath || resolveCopilotSettingsPath())?.disabledMcpServers;
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
}
function pickString(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim())
            return v.trim();
    }
    return undefined;
}
// Reads Reva fields from ~/.copilot/settings.json.
// Accepts:
//   - top-level REVA_* keys
//   - settings.env.REVA_* (an `env` block)
//   - nested "reva" object
// Unknown keys may show under Copilot's /settings Problems tab.
// `settingsPath` is for tests only — production always uses ~/.copilot/settings.json.
function readCopilotSettingsReva(settingsPath) {
    const file = settingsPath || resolveCopilotSettingsPath();
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(stripJsonc(raw));
        if (!parsed || typeof parsed !== 'object')
            return {};
        const settingsEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
            ? parsed.env
            : {};
        const nested = parsed.reva && typeof parsed.reva === 'object' && !Array.isArray(parsed.reva)
            ? parsed.reva
            : {};
        const debugRaw = pickString(settingsEnv.REVA_DEBUG, parsed.REVA_DEBUG, nested.debug !== undefined && nested.debug !== null ? String(nested.debug) : undefined);
        const debugFlag = settingsEnv.REVA_DEBUG === true ||
            parsed.REVA_DEBUG === true ||
            nested.debug === true ||
            (debugRaw !== undefined &&
                debugRaw !== '0' &&
                debugRaw.toLowerCase() !== 'false');
        return {
            // Prefer env{} (documented customer shape), then top-level, then reva{}.
            authToken: pickString(settingsEnv.REVA_AUTH_TOKEN, parsed.REVA_AUTH_TOKEN, nested.authToken, nested.auth_token, nested.REVA_AUTH_TOKEN),
            host: pickString(settingsEnv.REVA_HOST, parsed.REVA_HOST, nested.host, nested.REVA_HOST),
            agentId: pickString(settingsEnv.REVA_AGENT_ID, parsed.REVA_AGENT_ID, nested.agentId, nested.agent_id, nested.REVA_AGENT_ID),
            // Reva tokens / CODE_USER_SCOPE are keyed to a real email (often Gmail).
            // Set this when the GitHub email is private (only a public one can be
            // read) — the same address the store knows.
            userEmail: pickString(settingsEnv.REVA_USER_EMAIL, parsed.REVA_USER_EMAIL, nested.userEmail, nested.user_email, nested.REVA_USER_EMAIL),
            debug: debugFlag || undefined,
        };
    }
    catch {
        return {};
    }
}
