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
exports.debugLog = debugLog;
exports.debugLogPath = debugLogPath;
exports._resetDebugCacheForTests = _resetDebugCacheForTests;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const copilotSettings_1 = require("./copilotSettings");
const pluginData_1 = require("./pluginData");
const LOG_FILENAME = 'reva-debug.log';
function debugEnabled(env = process.env) {
    const fromEnv = env.REVA_DEBUG?.trim();
    if (fromEnv && fromEnv !== '0' && fromEnv.toLowerCase() !== 'false')
        return true;
    return Boolean((0, copilotSettings_1.readCopilotSettingsReva)().debug);
}
function resolveLogFile(env = process.env) {
    const dataDir = (0, pluginData_1.resolvePluginDataDir)(env);
    if (dataDir?.trim())
        return path.join(dataDir.trim(), LOG_FILENAME);
    return path.join(os.homedir(), '.copilot-governance', LOG_FILENAME);
}
let cachedEnabled;
let cachedLogFile;
function isEnabled() {
    if (cachedEnabled === undefined)
        cachedEnabled = debugEnabled();
    return cachedEnabled;
}
function logFile() {
    if (!cachedLogFile)
        cachedLogFile = resolveLogFile();
    return cachedLogFile;
}
// Opt-in via REVA_DEBUG (env or ~/.copilot/settings.json). Always writes to
// stderr (unmodified). Also appends a timestamped copy to the plugin data
// dir log — Copilot's TUI often hides hook stderr, and the file accumulates
// across every hook invocation, so timestamps matter there. Stderr's own
// line stays untimestamped since nothing else about its format has changed.
function debugLog(message) {
    if (!isEnabled())
        return;
    try {
        process.stderr.write(`[reva-security] ${message}\n`);
    }
    catch {
        // ignore
    }
    try {
        const file = logFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    }
    catch {
        // ignore — never fail a hook over logging
    }
}
function debugLogPath(env = process.env) {
    return resolveLogFile(env);
}
function _resetDebugCacheForTests() {
    cachedEnabled = undefined;
    cachedLogFile = undefined;
}
