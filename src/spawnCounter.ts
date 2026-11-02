import * as fs from 'node:fs';
import * as path from 'node:path';

// Tracks how many subagents have been spawned so far *this turn*, so a
// Cedar policy can see "this is spawn #4" and enforce a per-turn cap (e.g.
// deny when subagentIndex > 5). Resets to 0 at the start of every new turn
// (see resetSpawnCounter, called from authorizePrompt.ts's startTurn) —
// deliberately NOT a running total for the whole session, since a cap meant
// to bound one turn's fan-out would otherwise keep tightening across a long
// session until every later turn's first spawn was already over the limit.
// Persisted per session_id since each hook invocation is a separate,
// stateless process. The read-increment-write below is wrapped in a lock
// (see acquireLock) so two PreToolUse processes racing to spawn at the same
// moment can't both read the same "current" value and hand out a duplicate
// index — Copilot normally invokes one session's hooks sequentially,
// but nothing here should depend on that holding true forever.

// No fallback: only ever writes inside COPILOT_PLUGIN_DATA (also aliased as
// PLUGIN_DATA / CLAUDE_PLUGIN_DATA — see pluginData.ts). Without it, there
// is nothing honest to write to — nextSpawnIndex still returns a value (every
// call is index 1, since nothing persists), it just can't actually count
// across calls.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'spawns') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.count`);
}

const LOCK_MAX_WAIT_MS = 2000;
const LOCK_RETRY_DELAY_MS = 5;
// An abandoned lock (a process that died between mkdir and rmdir) is treated
// as stale past this age, so a crash doesn't cost every later spawn the full
// LOCK_MAX_WAIT_MS stall for a lock nobody will ever release.
const LOCK_STALE_MS = 5000;

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // synchronous spin — Node has no blocking sleep primitive, and this is
    // a short-lived CLI process, not a server, so busy-waiting a few
    // milliseconds here is cheaper and simpler than any async alternative
  }
}

// mkdir is atomic across processes on every platform Node supports: exactly
// one caller ever succeeds creating a given directory, everyone else gets
// EEXIST. That makes it a correct, dependency-free mutex without needing a
// real file-locking library. Best-effort on timeout: if some other process
// still holds the lock after LOCK_MAX_WAIT_MS, proceed WITHOUT it rather
// than block/deny the tool call — a rare, brief race producing a duplicate
// index is far better than governance ever hanging or failing closed over
// its own bookkeeping.
function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return false;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) fs.rmdirSync(lockPath);
      } catch {
        // lost the race to another process also clearing it, or the holder
        // just released it normally — either way, loop and retry the mkdir
      }
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // already gone — nothing to do
  }
}

export function nextSpawnIndex(sessionId: string, pluginDataDir?: string): number {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return 1;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // if the directory can't even be created, the lock/read/write below
    // will fail the same way the old unlocked version did — still returns
    // a usable value, just not guaranteed to persist
  }

  const lockPath = `${file}.lock`;
  const locked = acquireLock(lockPath);
  try {
    let current = 0;
    try {
      current = Number(fs.readFileSync(file, 'utf8').trim()) || 0;
    } catch {
      current = 0;
    }
    const next = current + 1;
    try {
      fs.writeFileSync(file, String(next), 'utf8');
    } catch {
      // best effort — if persistence fails, this call still gets a value,
      // just not guaranteed to increment correctly on the next spawn
    }
    return next;
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

// Called once per turn, from UserPromptSubmit (authorizePrompt.ts), right
// alongside startTurn() — so this turn's first spawn is #1 again, not a
// continuation of every prior turn's count.
export function resetSpawnCounter(sessionId: string, pluginDataDir?: string): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already absent (first turn ever, or already reset) — nothing to do
  }
}
