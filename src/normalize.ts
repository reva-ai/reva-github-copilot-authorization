import {
  PostToolUseInput,
  PreToolUseInput,
  StopInput,
  UserPromptSubmitInput,
} from './types';

function asRecord(value: unknown): Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

function parseToolArgs(raw: unknown): Record<string, any> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return asRecord(parsed);
    } catch {
      return { raw };
    }
  }
  return asRecord(raw);
}

/** Normalize Copilot camelCase or Claude/VS Code snake_case PreToolUse payloads. */
export function normalizePreToolUse(raw: Record<string, any>): PreToolUseInput {
  const toolInput = parseToolArgs(raw.toolArgs ?? raw.tool_input ?? raw.toolInput);
  return {
    session_id: pickString(raw.sessionId, raw.session_id) || 'unknown-session',
    prompt_id: pickString(raw.promptId, raw.prompt_id),
    cwd: pickString(raw.cwd) || process.cwd(),
    hook_event_name: pickString(raw.hook_event_name, raw.hookEventName) || 'preToolUse',
    tool_name: pickString(raw.toolName, raw.tool_name) || 'unknown',
    tool_input: toolInput,
    agent_id: pickString(raw.agentId, raw.agent_id, raw.subagentId, raw.subagent_id),
    agent_type: pickString(raw.agentType, raw.agent_type, raw.agentName, raw.agent_name),
  };
}

export function normalizePostToolUse(raw: Record<string, any>): PostToolUseInput {
  const base = normalizePreToolUse(raw);
  const toolResult = raw.toolResult ?? raw.tool_result ?? raw.tool_response;
  let tool_response: unknown = toolResult;
  if (toolResult != null && typeof toolResult === 'object' && !Array.isArray(toolResult)) {
    const tr = toolResult as Record<string, any>;
    tool_response =
      tr.textResultForLlm ?? tr.text_result_for_llm ?? tr.result ?? toolResult;
  }
  return {
    ...base,
    hook_event_name: pickString(raw.hook_event_name, raw.hookEventName) || 'postToolUse',
    tool_response,
    tool_use_id: pickString(raw.toolUseId, raw.tool_use_id),
    duration_ms:
      typeof raw.durationMs === 'number'
        ? raw.durationMs
        : typeof raw.duration_ms === 'number'
          ? raw.duration_ms
          : undefined,
  };
}

export function normalizeUserPrompt(raw: Record<string, any>): UserPromptSubmitInput {
  return {
    session_id: pickString(raw.sessionId, raw.session_id) || 'unknown-session',
    prompt_id: pickString(raw.promptId, raw.prompt_id),
    cwd: pickString(raw.cwd) || process.cwd(),
    hook_event_name: pickString(raw.hook_event_name, raw.hookEventName) || 'userPromptSubmitted',
    prompt: pickString(raw.prompt, raw.userPrompt, raw.user_prompt) || '',
    agent_id: pickString(raw.agentId, raw.agent_id),
    agent_type: pickString(raw.agentType, raw.agent_type, raw.agentName, raw.agent_name),
    parent_agent_id: pickString(raw.parentAgentId, raw.parent_agent_id),
  };
}

export function normalizeSessionStart(raw: Record<string, any>): {
  session_id: string;
  cwd: string;
  source?: string;
} {
  return {
    session_id: pickString(raw.sessionId, raw.session_id) || 'unknown-session',
    cwd: pickString(raw.cwd) || process.cwd(),
    source: pickString(raw.source, raw.trigger),
  };
}

/**
 * Normalize Copilot CLI agentStop (camelCase) or VS Code Stop (snake_case).
 * Copilot documents sessionId / transcriptPath / stopReason / stop_hook_active
 * for it. The assistant's reply is read only if the host supplies it under
 * the names Copilot documents for subagentStop (`response`, or
 * `last_assistant_message` in the VS Code format).
 */
export function normalizeStop(raw: Record<string, any>): StopInput {
  return {
    session_id: pickString(raw.sessionId, raw.session_id) || 'unknown-session',
    cwd: pickString(raw.cwd) || process.cwd(),
    hook_event_name: pickString(raw.hook_event_name, raw.hookEventName) || 'agentStop',
    transcript_path: pickString(raw.transcriptPath, raw.transcript_path),
    stop_hook_active: typeof raw.stop_hook_active === 'boolean' ? raw.stop_hook_active : undefined,
    last_assistant_message: pickString(raw.last_assistant_message, raw.response),
  };
}
