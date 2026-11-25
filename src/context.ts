import * as nodeOs from 'node:os';
import { ActiveSession } from './activeSessions';
import { AGENT_TYPE } from './ingestionClient';
import { CedarActionMapping, DirectEvalTransmission } from './types';

// Sent as the invokeAgent userQuery. An RTG 413 fails open for that request,
// so raise this only after confirming the RTG accepts the resulting request
// size.
const MAX_PROMPT_LENGTH = 10000;

export function truncatePrompt(prompt: string): string {
  return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}

// Reva owns thread history for guardrail evaluators (the earlier hops of this
// trace and the earlier prompts of the thread). The plugin therefore sends no
// `context.hops`, `context.conversation` or `session.messages`: if the caller
// supplies them Reva keeps them and does not attach what it recorded.
export interface ActionContextExtras {
  subagentIndex?: number;
  activeSessionCount?: number;
  currentSession?: ActiveSession;
  machineId?: string;
  // The model Copilot is running for this call (copilotModel.ts); '' when it
  // cannot be read.
  model?: string;
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
export function osAttribute(platform: NodeJS.Platform = nodeOs.platform()): 'Linux' | 'Windows' | 'macOS' {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}

function activeSessionFields(extras: ActionContextExtras): Record<string, any> {
  return {
    activeSessionCount: extras.activeSessionCount ?? 0,
    sessionId: extras.currentSession?.sessionId ?? '',
    sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
    sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
    agentType: AGENT_TYPE,
    machineId: extras.machineId ?? '',
    os: osAttribute(),
    // Always sent, so a decision log records which model made each call.
    // Cedar context is closed: the schema must declare `model` on every action.
    model: extras.model ?? '',
  };
}

export function buildActionContext(
  mapping: CedarActionMapping,
  extras: ActionContextExtras = {},
): Record<string, any> {
  const timestamp = Date.now();
  const sessions = activeSessionFields(extras);
  switch (mapping.actionName) {
    case 'invokeTool':
      return { timestamp, ...sessions };
    case 'spawn':
      return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...sessions };
    case 'executeBash':
      return { timestamp, command: mapping.command ?? '', ...sessions };
    case 'read':
    case 'write':
    case 'edit':
    case 'glob':
    case 'grep':
      return { timestamp, ...sessions };
    default:
      return { timestamp, ...sessions };
  }
}

export function buildInvokeAgentContext(
  activeSessionCount = 0,
  currentSession?: ActiveSession,
  machineId?: string,
  extras: Pick<ActionContextExtras, 'model'> = {},
): Record<string, any> {
  return {
    timestamp: Date.now(),
    ...activeSessionFields({ activeSessionCount, currentSession, machineId, ...extras }),
  };
}

export function buildTransmission(
  content: string,
  role: DirectEvalTransmission['role'],
  nonblankFallback?: string,
): DirectEvalTransmission {
  const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
  if (!userQuery) {
    throw new Error('direct AI evaluation requires a nonblank current prompt');
  }
  return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}

const MAX_TOOL_RESPONSE_LENGTH = 10000;

export function serializeToolResponse(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
  return raw.length > MAX_TOOL_RESPONSE_LENGTH
    ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…`
    : raw;
}

// userQuery is the same prompt PreToolUse sent, so a pre/post pair shows one
// prompt, and the tool's output travels separately in transmission.response.
export function buildToolResponseTransmission(toolResponse: unknown, userQuery: string): DirectEvalTransmission {
  const transmission = buildTransmission(userQuery, 'tool');
  transmission.response = serializeToolResponse(toolResponse);
  return transmission;
}
