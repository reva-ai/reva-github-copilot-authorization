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
exports.osAttribute = osAttribute;
exports.buildActionContext = buildActionContext;
exports.buildInvokeAgentContext = buildInvokeAgentContext;
exports.buildTransmission = buildTransmission;
exports.serializeToolResponse = serializeToolResponse;
exports.buildToolResponseTransmission = buildToolResponseTransmission;
const nodeOs = __importStar(require("node:os"));
const ingestionClient_1 = require("./ingestionClient");
function activeTurnEvidence(extras) {
    const messages = extras.conversationMessages || [];
    return {
        hops: extras.hops || [],
        ...(messages.length > 0 ? { conversation: { messages } } : {}),
    };
}
// The OS this call runs on, sent as context.os on every action. macOS is
// reported as itself rather than folded into "Linux", which would make Mac
// sessions show up as Linux in decision logs. Cedar has no string enums, so
// the extra value is schema-safe — but a policy that matches
// context.os == "Linux" to mean "any POSIX machine" must also match
// "macOS". The Agent entity records the same fact as operatingSystems
// (osFamily in deviceId.ts) at session start.
//
// Exported (with an injectable platform, defaulting to the real one) so tests
// can cover the mapping directly without mocking node:os.
function osAttribute(platform = nodeOs.platform()) {
    if (platform === 'win32')
        return 'Windows';
    if (platform === 'darwin')
        return 'macOS';
    return 'Linux';
}
function activeSessionFields(extras) {
    return {
        activeSessionCount: extras.activeSessionCount ?? 0,
        sessionId: extras.currentSession?.sessionId ?? '',
        sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
        sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
        agentType: ingestionClient_1.AGENT_TYPE,
        machineId: extras.machineId ?? '',
        os: osAttribute(),
        // Gated: Cedar context is closed, so `model` may
        // only be sent once the schema declares it on every action — sending it
        // earlier turns every request into a schema-violation deny.
        ...(extras.modelContext ? { model: extras.model ?? '' } : {}),
    };
}
function buildActionContext(mapping, extras = {}) {
    const timestamp = Date.now();
    const evidence = activeTurnEvidence(extras);
    const sessions = activeSessionFields(extras);
    switch (mapping.actionName) {
        case 'invokeTool':
            return { timestamp, ...evidence, ...sessions };
        case 'spawn':
            return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...evidence, ...sessions };
        case 'executeBash':
            return { timestamp, command: mapping.command ?? '', ...evidence, ...sessions };
        case 'read':
        case 'write':
        case 'edit':
        case 'glob':
        case 'grep':
            return { timestamp, ...evidence, ...sessions };
        default:
            return { timestamp, ...evidence, ...sessions };
    }
}
function buildInvokeAgentContext(activeSessionCount = 0, currentSession, machineId, extras = {}) {
    return {
        timestamp: Date.now(),
        hops: [],
        ...activeSessionFields({ activeSessionCount, currentSession, machineId, ...extras }),
    };
}
function buildTransmission(content, role, nonblankFallback) {
    const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
    if (!userQuery) {
        throw new Error('direct AI evaluation requires a nonblank current prompt');
    }
    return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}
const MAX_TOOL_RESPONSE_LENGTH = 10000;
function serializeToolResponse(toolResponse) {
    if (toolResponse == null)
        return '';
    const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    return raw.length > MAX_TOOL_RESPONSE_LENGTH
        ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…`
        : raw;
}
// userQuery is the same current-hop prompt PreToolUse sent, so a pre/post
// pair shows one prompt,
// and the tool's output travels separately in transmission.response.
function buildToolResponseTransmission(toolResponse, userQuery) {
    const transmission = buildTransmission(userQuery, 'tool');
    transmission.response = serializeToolResponse(toolResponse);
    return transmission;
}
