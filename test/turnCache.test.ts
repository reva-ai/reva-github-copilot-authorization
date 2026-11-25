import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  directSessionFromTurn,
  loadOrStartTurn,
  loadTurn,
  resolveTurnTraceId,
  startTurn,
} from '../src/turnCache';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-turn-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('startTurn persists a trace id that loadTurn reads back for the same session', () => {
  withTempDir((dir) => {
    const turn = startTurn('sess-1', dir);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.traceId, turn.traceId);
    assert.equal(loaded?.turn, 1);
    assert.match(loaded?.startedAt || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('a second startTurn call for the same session overwrites the previous turn', () => {
  withTempDir((dir) => {
    const first = startTurn('sess-1', dir);
    const second = startTurn('sess-1', dir);
    assert.notEqual(first.traceId, second.traceId);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.traceId, second.traceId);
    assert.equal(loaded?.turn, 2);
    assert.equal(second.startedAt, first.startedAt);
  });
});

test('different sessions get independent turn entries', () => {
  withTempDir((dir) => {
    const a = startTurn('sess-a', dir);
    const b = startTurn('sess-b', dir);
    assert.notEqual(a.traceId, b.traceId);
    assert.equal(loadTurn('sess-a', dir)?.traceId, a.traceId);
    assert.equal(loadTurn('sess-b', dir)?.traceId, b.traceId);
  });
});

test('loadTurn returns undefined for a session that never started a turn', () => {
  withTempDir((dir) => {
    assert.equal(loadTurn('never-seen', dir), undefined);
  });
});

test('the turn cache file holds only a trace id, a turn number and timestamps', () => {
  withTempDir((dir) => {
    startTurn('sess-1', dir);
    startTurn('sess-1', dir);
    loadOrStartTurn('sess-1', dir);

    const raw = fs.readFileSync(path.join(dir, 'turns', 'sess-1.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['promptTimestamp', 'startedAt', 'traceId', 'turn']);
  });
});

test('direct session is the thread id only: no turn, start time or messages', () => {
  const session = directSessionFromTurn('sess-1');
  assert.deepEqual(session, { id: 'sess-1' });
  for (const key of ['turn', 'startedAt', 'messages']) assert.equal(key in session, false);
});

test('with no pluginDataDir, startTurn/loadTurn still work but never persist — no fallback to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  const turn = startTurn('sess-1', undefined);
  assert.equal(turn.turn, 1); // still a usable entry for this call
  assert.equal(loadTurn('sess-1', undefined), undefined); // but never actually persisted

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});

test('with no pluginDataDir the trace id is derived, so separate hooks still share a turn', () => {
  // A minted id can only be shared if it can be persisted — every later hook
  // in the turn is its own process and reads it back from the cache. Without
  // a cache to write to, minting would give each process a different random
  // id and the turn would fragment into one trace per RTG call.
  const a = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  const b = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  assert.equal(a, b, 'separate processes must agree with no cache available');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('an upgrade from a pre-traceId cache entry keeps the turn and derives a shared trace', () => {
  withTempDir((dir) => {
    // Exactly the shape written before traceId existed: spanId, no traceId.
    fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'turns', 'sess-old.json'),
      JSON.stringify({
        spanId: 'c515b2193e5f1234',
        promptTimestamp: '2026-09-20T10:00:00.000Z',
        turn: 13,
        startedAt: '2026-09-20T09:00:00.000Z',
        prompt: 'an older prompt',
      }),
      'utf8',
    );

    const turn = loadOrStartTurn('sess-old', dir);
    // The turn must be REUSED, not restarted — restarting would bump the
    // counter and lose the conversation's own history.
    assert.equal(turn.turn, 13);
    assert.equal(turn.startedAt, '2026-09-20T09:00:00.000Z');
    assert.equal(turn.traceId, undefined);

    // …and every hook still agrees on a trace for it, via the fallback.
    const first = resolveTurnTraceId('sess-old', turn);
    const second = resolveTurnTraceId('sess-old', loadOrStartTurn('sess-old', dir));
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{32}$/);

    // The next prompt recovers to a minted id and drops the stale fields,
    // including the prompt text the earlier version stored.
    const next = startTurn('sess-old', dir);
    assert.match(next.traceId || '', /^[0-9a-f]{32}$/);
    assert.equal(next.turn, 14);
    assert.equal(next.startedAt, '2026-09-20T09:00:00.000Z');
    assert.ok(!('spanId' in next));
    assert.ok(!('prompt' in next));
    assert.equal(fs.readFileSync(path.join(dir, 'turns', 'sess-old.json'), 'utf8').includes('an older prompt'), false);
  });
});

test('an old entry that still carries prompt text is read, but loadOrStartTurn never writes it back', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'turns', 'sess-legacy.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = JSON.stringify({
      traceId: 'a'.repeat(32),
      promptTimestamp: '2026-09-20T10:00:00.000Z',
      turn: 5,
      startedAt: '2026-09-20T09:00:00.000Z',
      prompt: 'legacy prompt text',
    });
    fs.writeFileSync(file, legacy, 'utf8');

    const turn = loadOrStartTurn('sess-legacy', dir);
    assert.equal(turn.turn, 5);
    assert.equal(turn.traceId, 'a'.repeat(32));
    // Complete entries are returned as found; nothing rewrites the file.
    assert.equal(fs.readFileSync(file, 'utf8'), legacy);

    // A new turn builds a fresh entry without the old prompt.
    startTurn('sess-legacy', dir);
    assert.equal(fs.readFileSync(file, 'utf8').includes('legacy prompt text'), false);
  });
});
