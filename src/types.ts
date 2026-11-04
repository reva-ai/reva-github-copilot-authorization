export interface RevaConfig {
  rtgUrl: string;
  // Sent as the X-API-Token header on BOTH evaluation and ingestion calls —
  // one Reva auth token authenticates everything this plugin does.
  authorization: string;
  // The Cedar `Agent` entity's id — a stable GitHub account id when available
  // (see deviceId.ts's resolveAgentId). No fallback: loadConfig() throws if
  // neither a GitHub account id nor REVA_AGENT_ID is available.
  agentId: string;
  timeoutMs: number;
  ingestionUrl: string;
  ingestionTimeoutMs: number;
}

// Normalized internal shape — Copilot may deliver camelCase (native CLI) or
// snake_case (VS Code / Claude-compatible PascalCase events). Entrypoints
// normalize before using these types.
export interface PreToolUseInput {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, any>;
  // Present when the tool call originates from a spawned subagent.
  agent_id?: string;
  agent_type?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
}

export interface UserPromptSubmitInput {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
  // Copilot: present only on a spawned subagent's kickoff prompt, where
  // session_id is the subagent's own id (see subAgentRegistry.ts).
  agent_id?: string;
  agent_type?: string;
  parent_agent_id?: string;
}

export interface CedarEntityRef {
  type: string;
  id: string;
}

export interface DirectEvalEntitySpec extends CedarEntityRef {
  name?: string;
  properties?: Record<string, any>;
  parents?: CedarEntityRef[];
  tool?: string;
  origin?: string;
  endpoint?: string;
}

export interface CedarEntityDescriptor {
  uid: CedarEntityRef;
  attrs: Record<string, any>;
  parents: CedarEntityRef[];
}

export interface CedarHop {
  seq: number;
  subject: CedarEntityRef;
  action: { name: string };
  resource: CedarEntityRef;
  time: string;
}

export interface DirectEvalConversationMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  content: string;
  timestamp: string;
}

export interface DirectEvalTransmission {
  promptKey: 'userQuery';
  userQuery: string;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  // PostToolUse only: the tool's output, kept out of userQuery so the
  // pre/post pair shares one prompt.
  response?: string;
}

export interface DirectEvalSession {
  id: string;
  turn: number;
  startedAt: string;
}

export interface CedarRequest {
  subject: DirectEvalEntitySpec;
  principal: DirectEvalEntitySpec;
  action: { name: string };
  resource: DirectEvalEntitySpec;
  context: Record<string, any>;
  transmission: DirectEvalTransmission;
  session: DirectEvalSession;
}

export type RtgDecision = 'allow' | 'deny' | 'ask';

export interface RtgResult {
  decision: RtgDecision;
  // A 401 or operational 5xx disables Reva enforcement for this request.
  // Hook writers must emit no Copilot decision in this state: emitting an
  // explicit `allow` would bypass Copilot's own normal permission flow.
  inactive?: boolean;
  reason?: string;
  raw?: any;
  errorType?: string;
  status?: number;
}

export type CedarActionName =
  | 'executeBash'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'invokeTool'
  | 'spawn'
  | 'invokeAgent';

export interface CedarActionMapping {
  actionName: CedarActionName;
  resourceType: string;
  resourceId: string;
  resourceProperties?: Record<string, any>;
  resourceParents?: CedarEntityRef[];
  command?: string;
  pattern?: string;
  tool?: string;
}

// One tool call can touch several resources (an apply_patch naming several
// files). Each is evaluated as its own request and the answers composed
// deny-if-any — see evaluateAll.ts. An empty `mappings` means the targets
// could not be determined, which callers fail closed on.
export interface ToolMapping {
  mappings: CedarActionMapping[];
  // A shell command naming more distinct paths than MAX_SHELL_RESOURCES:
  // denied rather than evaluated partially or widened to a common ancestor.
  overCap?: boolean;
  candidateCount?: number;
}

export interface SessionContext {
  id: string;
  traceId: string;
  spanId: string;
}
