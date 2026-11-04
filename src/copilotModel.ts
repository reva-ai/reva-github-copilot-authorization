import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Which model Copilot CLI is running for a session. Copilot's hook payloads
// carry no model field, so it is read from the session record Copilot itself
// writes:
//
//   $COPILOT_HOME/session-state/<sessionId>/events.jsonl   (default ~/.copilot)
//
// Event shapes as written by CLI 1.0.103:
//   session.model_change        data.newModel     — an explicit model, or "auto"
//   session.auto_mode_resolved  data.chosenModel  — what Auto picked
//   subagent.configured         agentId + data.model — a subagent's model
//   session.start               data.selectedModel — the model a VS Code
//                               Copilot Chat session starts with; those
//                               sessions write no model_change at all
//
// The most recent applicable event wins (a /model switch mid-session
// replaces the earlier one); session.start is the first line, so its
// selectedModel only counts when nothing later names a model. "auto" alone
// is not a model, so it never resolves to anything by itself. The per-event
// `model` field is never used: it includes helper models (e.g. the one that
// writes chat titles). Nothing found → undefined; never guessed.

const MODEL_CHANGE = '"session.model_change"';
const AUTO_RESOLVED = '"session.auto_mode_resolved"';
const SESSION_START = '"session.start"';
const SUBAGENT_CONFIGURED = '"subagent.configured"';

export function resolveCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME?.trim() || path.join(os.homedir(), '.copilot');
}

// Shared with copilotMcp.ts, which reads the same record for MCP calls.
export function readEvents(sessionId: string, copilotHome: string): string[] {
  if (!sessionId) return [];
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    return fs.readFileSync(path.join(copilotHome, 'session-state', safe, 'events.jsonl'), 'utf8').split('\n');
  } catch {
    return [];
  }
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export interface ResolveModelOptions {
  // The session whose events.jsonl holds the record — for a Copilot subagent
  // that is its parent (root) session, where subagent.configured is written.
  sessionId: string;
  // Set for a subagent's own calls: its model comes from subagent.configured.
  subAgentId?: string;
  copilotHome?: string;
}

export function resolveCopilotModel(opts: ResolveModelOptions): string | undefined {
  const lines = readEvents(opts.sessionId, opts.copilotHome || resolveCopilotHome());

  if (opts.subAgentId) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(SUBAGENT_CONFIGURED) || !lines[i].includes(opts.subAgentId)) continue;
      const e = parse(lines[i]);
      if (e?.type === 'subagent.configured' && e.agentId === opts.subAgentId && typeof e.data?.model === 'string') {
        return e.data.model;
      }
    }
    // Not configured with its own model: it runs on the session's model.
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes(AUTO_RESOLVED)) {
      const e = parse(line);
      const chosen = e?.data?.chosenModel;
      if (e?.type === 'session.auto_mode_resolved' && typeof chosen === 'string' && chosen) return chosen;
    } else if (line.includes(MODEL_CHANGE)) {
      const e = parse(line);
      const model = e?.data?.newModel;
      if (e?.type !== 'session.model_change' || typeof model !== 'string' || !model) continue;
      // An explicit model is the answer. "auto" means the concrete model is
      // only known from a later auto_mode_resolved — which the backward scan
      // would already have returned had one existed.
      if (model.toLowerCase() !== 'auto') return model;
      return undefined;
    } else if (line.includes(SESSION_START)) {
      const e = parse(line);
      const selected = e?.data?.selectedModel;
      if (e?.type !== 'session.start' || typeof selected !== 'string' || !selected) continue;
      return selected.toLowerCase() !== 'auto' ? selected : undefined;
    }
  }
  return undefined;
}
