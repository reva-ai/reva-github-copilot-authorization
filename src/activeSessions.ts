import * as fs from 'node:fs';
import * as path from 'node:path';

// Tracks which session_ids are currently active on THIS machine, keyed by
// Agent id (the account id everything else in this plugin uses — see
// deviceId.ts's resolveAgentId) — the local half of "how many Copilot
// sessions are running right now," e.g. two terminal tabs, or CLI + desktop
// app at once. The cache file itself is still local to this one machine
// (COPILOT_PLUGIN_DATA), so keying by an account id that's shared across
// machines doesn't cause cross-machine collisions — the same account logged
// into two machines just gets two independent local files, each keyed by
// that same id.
// SessionStart registers a session; PreToolUse/UserPromptSubmit refresh
// lastSeen for whichever session is still actually being used; SessionEnd
// (sessionEnd.ts, via markSessionInactive) removes it immediately when it
// fires. That last one isn't guaranteed to fire on an abrupt termination
// (killed process, closed terminal) — for exactly that gap, a session not
// seen in ACTIVE_TTL_MS is treated as gone and pruned outright on the next
// read or write, not just filtered out at read time, so this file can't
// grow unbounded even if SessionEnd never runs at all.
//
// Deliberately local-only: this has no visibility into other machines, so
// it can only ever answer "how many sessions on THIS machine," not a true
// cross-machine concurrent-session count.
//
// Best-effort throughout, same as turnCache/hopChain/spawnCounter: if the
// cache can't be read or written, callers just get an empty/best-guess
// result rather than failing the request.

interface SessionEntry {
  entrypoint: string;
  lastSeen: number;
  // The editor found by walking this session's parent processes (identity.ts):
  // a name, null when the walk found none, absent when it has not run yet.
  // Kept across refreshes so the walk happens once per session.
  editorFromProcess?: string | null;
}

interface ActiveSessionsState {
  sessions: Record<string, SessionEntry>;
}

const ACTIVE_TTL_MS = 10 * 60 * 1000; // no activity for 10 minutes ⇒ treated as gone

// No fallback: only ever writes inside COPILOT_PLUGIN_DATA (also aliased as
// PLUGIN_DATA / CLAUDE_PLUGIN_DATA — see pluginData.ts). Without it, there
// is nothing honest to write to, so every function below just no-ops/returns
// an empty result rather than inventing a location of its own.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'active-sessions') : undefined;
}

function cacheFile(agentId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadState(agentId: string, pluginDataDir?: string): ActiveSessionsState {
  const file = cacheFile(agentId, pluginDataDir);
  if (!file) return { sessions: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
  } catch {
    return { sessions: {} };
  }
}

function saveState(agentId: string, state: ActiveSessionsState, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(agentId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch {
    // best effort — the next call just tries again
  }
}

// Drops any entry not seen within ACTIVE_TTL_MS — called on every write so
// the file can't accumulate sessions that closed hours/days ago.
function pruneStale(state: ActiveSessionsState): ActiveSessionsState {
  const now = Date.now();
  const sessions: Record<string, SessionEntry> = {};
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    if (now - entry.lastSeen < ACTIVE_TTL_MS) {
      sessions[sessionId] = entry;
    }
  }
  return { sessions };
}

export interface ActiveSession {
  sessionId: string;
  entrypoint: string;
  lastSeen: number;
  editorFromProcess?: string | null;
}

// Registers (or refreshes) this session as active, and returns the entry
// just written — callers use this directly for the current session's own
// context fields (sessionId/sessionEntryPoint/sessionLastSeen), no separate
// read needed. Called from SessionStart (first sight of a session) and
// PreToolUse/UserPromptSubmit (keeps lastSeen current for as long as the
// session keeps being used). See markSessionInactive below for the
// counterpart that removes an entry on SessionEnd. Returns undefined for
// an empty/missing sessionId — nothing honest to record (avoids a literal
// "undefined" key) or report.
export function markSessionActive(
  agentId: string,
  sessionId: string,
  entrypoint: string,
  pluginDataDir?: string,
): ActiveSession | undefined {
  if (!sessionId) return undefined;
  const state = pruneStale(loadState(agentId, pluginDataDir));
  const previous = state.sessions[sessionId];
  const entry: SessionEntry = {
    entrypoint,
    lastSeen: Date.now(),
    ...(previous?.editorFromProcess !== undefined ? { editorFromProcess: previous.editorFromProcess } : {}),
  };
  state.sessions[sessionId] = entry;
  saveState(agentId, state, pluginDataDir);
  return { sessionId, ...entry };
}

// Saves the result of identity.ts's parent-process walk for this session, so
// later hooks reuse it instead of walking again.
export function recordSessionEditor(
  agentId: string,
  sessionId: string,
  editor: string | null,
  pluginDataDir?: string,
): void {
  if (!sessionId) return;
  const state = pruneStale(loadState(agentId, pluginDataDir));
  const previous = state.sessions[sessionId];
  state.sessions[sessionId] = {
    entrypoint: previous?.entrypoint ?? '',
    lastSeen: previous?.lastSeen ?? Date.now(),
    editorFromProcess: editor,
  };
  saveState(agentId, state, pluginDataDir);
}

// Every session currently considered active for this Agent's local
// registry (keyed by agentId, but the underlying file always lives on
// exactly one machine regardless of what agentId itself represents),
// including the caller's own — so 1 means only this session is active, 2+
// means at least one other tab/window/app is also running right now.
export function getActiveSessions(agentId: string, pluginDataDir?: string): ActiveSession[] {
  const state = pruneStale(loadState(agentId, pluginDataDir));
  return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}

export function getActiveSessionCount(agentId: string, pluginDataDir?: string): number {
  return getActiveSessions(agentId, pluginDataDir).length;
}

// Read-only lookup of one session's own entry, without refreshing it —
// used by PostToolUse, where PreToolUse already refreshed lastSeen moments
// earlier in the same tool-call cycle.
export function getSessionEntry(agentId: string, sessionId: string, pluginDataDir?: string): ActiveSession | undefined {
  return getActiveSessions(agentId, pluginDataDir).find((s) => s.sessionId === sessionId);
}

// Explicit removal, called from SessionEnd (sessionEnd.ts) when it fires —
// the one non-TTL way an entry leaves this file. SessionEnd isn't
// guaranteed to fire on an abrupt termination (killed process, closed
// terminal) — the TTL above stays as the fallback for exactly that gap;
// this is just the fast path for a graceful one, so a session doesn't
// linger as "active" for up to ACTIVE_TTL_MS after it's actually gone.
export function markSessionInactive(agentId: string, sessionId: string, pluginDataDir?: string): void {
  if (!sessionId) return;
  const state = pruneStale(loadState(agentId, pluginDataDir));
  if (sessionId in state.sessions) {
    delete state.sessions[sessionId];
    saveState(agentId, state, pluginDataDir);
  }
}
