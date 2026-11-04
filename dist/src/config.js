"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HOST = void 0;
exports.urlFromHost = urlFromHost;
exports.resolveConfiguredAgentId = resolveConfiguredAgentId;
exports.loadConfig = loadConfig;
const copilotSettings_1 = require("./copilotSettings");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const DEFAULT_TIMEOUT_MS = 25000;
// The path segment itself is Reva's actual API route — part of the public
// API contract, fixed by the backend, so it must not change.
const RTG_PATH = '/pdp/v2/ai/evaluation';
const INGESTION_PATH = '/ingestion/v2';
exports.DEFAULT_HOST = 'api.reva.ai';
const DEFAULT_INGESTION_TIMEOUT_MS = 5000;
// Whether a config value arrived, WITHOUT ever revealing it. "set" vs
// "empty" vs "absent" are three different problems: absent means nobody
// configured it, empty means something tried to supply it and handed over
// nothing, and those need opposite fixes.
function describePresence(value) {
    if (value === undefined)
        return 'absent';
    if (value.length === 0)
        return 'present but EMPTY';
    return `set (${value.length} chars)`;
}
function normalizeHost(raw) {
    return raw.trim().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}
function schemeForHost(host) {
    const h = host.toLowerCase();
    if (h.startsWith('localhost') || h.startsWith('127.0.0.1') || h.startsWith('[::1]')) {
        return 'http';
    }
    return 'https';
}
function urlFromHost(host, path) {
    const normalized = normalizeHost(host);
    return `${schemeForHost(normalized)}://${normalized}${path}`;
}
// The Agent id, resolved the same way by EVERY hook: settings.json
// REVA_AGENT_ID → process REVA_AGENT_ID → the Copilot account id
// (copilotAccount.ts). sessionStart/sessionEnd used to skip settings.json,
// so a pinned id there registered/removed sessions under a different key
// than the one every other hook counted them under. allowLookup: false
// (sessionEnd) reads the cached account id only.
function resolveConfiguredAgentId(env = process.env, settingsPath, opts = {}) {
    return (0, copilotSettings_1.readCopilotSettingsReva)(settingsPath).agentId || env.REVA_AGENT_ID?.trim() || (0, deviceId_1.resolveAgentId)(opts);
}
// Copilot does NOT inject settings.json `env` into hooks, so REVA_HOST never
// shows up in process.env on its own; we read the same keys from
// ~/.copilot/settings.json ourselves (token/agentId already did). For the
// host, process env wins when set (CI / shell), else settings.env /
// top-level / reva{}, else default.
// `settingsPath` is for tests only — production always reads ~/.copilot/settings.json.
function loadConfig(env = process.env, settingsPath) {
    const fromSettings = (0, copilotSettings_1.readCopilotSettingsReva)(settingsPath);
    const authorization = fromSettings.authToken || env.REVA_AUTH_TOKEN?.trim() || '';
    const host = env.REVA_HOST?.trim() || fromSettings.host || exports.DEFAULT_HOST;
    const rtgUrl = urlFromHost(host, RTG_PATH);
    const ingestionUrl = urlFromHost(host, INGESTION_PATH);
    (0, debug_1.debugLog)(`loadConfig: host=${host} rtgUrl=${rtgUrl}`);
    if (!authorization) {
        (0, debug_1.debugLog)(`loadConfig: no auth token — REVA_AUTH_TOKEN ${describePresence(env.REVA_AUTH_TOKEN)}, ` +
            `settings.authToken ${describePresence(fromSettings.authToken)}`);
        throw new Error('Reva governance is not configured — missing: REVA_AUTH_TOKEN ' +
            '(set it in ~/.copilot/settings.json, or export REVA_AUTH_TOKEN)');
    }
    const agentId = fromSettings.agentId || env.REVA_AGENT_ID?.trim() || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)(`loadConfig: no agent id — REVA_AGENT_ID ${describePresence(env.REVA_AGENT_ID)}, ` +
            `settings.agentId ${describePresence(fromSettings.agentId)}, ` +
            'resolveAgentId() returned nothing (no Copilot account id: not cached, and gh api copilot_internal/user unavailable or signed in as a different login)');
        throw new Error('Reva governance is not configured — missing: REVA_AGENT_ID (could not resolve the Copilot account id — run `gh auth login` as the same account Copilot uses, or set REVA_AGENT_ID in settings.json or the environment)');
    }
    return {
        rtgUrl,
        authorization,
        agentId,
        // REVA_PDP_TIMEOUT_MS is a public, documented config variable — its
        // name is part of the public contract and must not change, so an
        // existing deployment that already sets it doesn't silently stop
        // working.
        timeoutMs: Number(env.REVA_PDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ingestionUrl,
        ingestionTimeoutMs: Number(env.REVA_INGESTION_TIMEOUT_MS) || DEFAULT_INGESTION_TIMEOUT_MS,
    };
}
