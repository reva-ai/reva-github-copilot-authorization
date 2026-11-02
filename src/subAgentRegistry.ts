import * as fs from 'node:fs';
import * as path from 'node:path';
import { CedarHop } from './types';

// Copilot CLI gives every spawned subagent its OWN sessionId (= the
// subagent's agentId) rather than keeping the parent's session_id on its tool
// calls, and sends agentId / agentType / parentAgentId ONLY on that
// subagent's first userPromptSubmitted. Its later preToolUse / postToolUse
// calls carry just the child sessionId, nothing else.
//
// Without this registry each subagent would therefore look like a brand-new
// top-level session: its kickoff would be evaluated as a human invokeAgent,
// its tool calls would run as the top-level Agent with hops=0, and Reva would
// see one extra session per subagent instead of one session with N subagents
// in it.
//
// So: on the subagent's userPromptSubmitted we record
// child sessionId → { parent sessionId, agentType, lineage } here, and every
// later hook looks its own sessionId up to recover the root session, the
// SubAgent identity and the delegation chain. Nested subagents chain
// naturally — a grandchild's parent is a registered child.
//
// Best-effort, like the other caches: a missing or corrupt entry just means
// the call is treated as top-level, never a throw.

export interface SubAgentEntry {
  // The subagent's own id — Copilot's agentId, which is also the sessionId
  // its hooks arrive with.
  subAgentId: string;
  parentSessionId: string;
  agentType: string;
  // The chain BEFORE this subagent's own actions: the parent's lineage plus
  // the spawn hop that created it. Bound once, at registration.
  lineage: CedarHop[];
  registeredAt: string;
}

export interface ResolvedSubAgent extends SubAgentEntry {
  // The top-level (human-driven) session this subagent ultimately belongs
  // to. Session id, turn, trace and spawn counting all key off this.
  rootSessionId: string;
}

// Guards the parent walk against a cyclic or absurdly deep registry.
const MAX_DEPTH = 16;

function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'subagents') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

function loadEntry(sessionId: string, pluginDataDir?: string): SubAgentEntry | undefined {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return undefined;
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as SubAgentEntry;
    return entry && typeof entry.parentSessionId === 'string' ? entry : undefined;
  } catch {
    return undefined;
  }
}

// Keyed by the sessionId the subagent's later hooks will arrive with.
export function registerSubAgent(sessionId: string, entry: SubAgentEntry, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  } catch {
    // best effort — the subagent's calls just fall back to top-level handling
  }
}

// Returns the registered subagent for this hook's sessionId, with its root
// session resolved, or undefined for a top-level session.
export function resolveSubAgent(sessionId: string, pluginDataDir?: string): ResolvedSubAgent | undefined {
  const entry = loadEntry(sessionId, pluginDataDir);
  if (!entry) return undefined;

  let rootSessionId = entry.parentSessionId;
  const seen = new Set([sessionId]);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (seen.has(rootSessionId)) break;
    seen.add(rootSessionId);
    const parent = loadEntry(rootSessionId, pluginDataDir);
    if (!parent) break;
    rootSessionId = parent.parentSessionId;
  }
  return { ...entry, rootSessionId };
}

// Called from sessionEnd for the top-level session: drops every subagent
// entry whose root is that session, so the directory doesn't grow forever.
export function removeSubAgentsOfSession(rootSessionId: string, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  if (!dir || !rootSessionId) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // Resolve every root first, then delete: removing a child before its
  // grandchild is resolved would cut the grandchild's walk short.
  const doomed = names.filter((name) => {
    if (!name.endsWith('.json')) return false;
    const resolved = resolveSubAgent(name.slice(0, -'.json'.length), pluginDataDir);
    return resolved?.rootSessionId === rootSessionId;
  });
  for (const name of doomed) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // best effort
    }
  }
}
