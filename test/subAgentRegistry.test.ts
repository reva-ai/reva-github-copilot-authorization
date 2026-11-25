import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveCaller } from '../src/identity';
import { normalizeUserPrompt } from '../src/normalize';
import { registerSubAgent, removeSubAgentsOfSession, resolveSubAgent, SubAgentEntry } from '../src/subAgentRegistry';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-subagents-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function entry(subAgentId: string, parentSessionId: string): SubAgentEntry {
  return { subAgentId, parentSessionId, agentType: 'explore', registeredAt: '2026-01-01T00:00:00.000Z' };
}

test('resolveSubAgent returns undefined for an unregistered (top-level) session', () => {
  withTempDir((dir) => {
    assert.equal(resolveSubAgent('parent', dir), undefined);
  });
});

test('resolveSubAgent resolves a direct child to its parent as root', () => {
  withTempDir((dir) => {
    registerSubAgent('child', entry('child', 'parent'), dir);
    const resolved = resolveSubAgent('child', dir);
    assert.equal(resolved?.rootSessionId, 'parent');
    assert.equal(resolved?.agentType, 'explore');
  });
});

test('resolveSubAgent walks nested subagents up to the top-level session', () => {
  withTempDir((dir) => {
    registerSubAgent('child', entry('child', 'parent'), dir);
    registerSubAgent('grandchild', entry('grandchild', 'child'), dir);
    assert.equal(resolveSubAgent('grandchild', dir)?.rootSessionId, 'parent');
  });
});

test('resolveSubAgent survives a cyclic registry without hanging', () => {
  withTempDir((dir) => {
    registerSubAgent('a', entry('a', 'b'), dir);
    registerSubAgent('b', entry('b', 'a'), dir);
    assert.ok(resolveSubAgent('a', dir));
  });
});

test('resolveSubAgent treats a corrupt entry as top-level', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', 'child.json'), '{ not json', 'utf8');
    assert.equal(resolveSubAgent('child', dir), undefined);
  });
});

test('registry is a no-op without a plugin data dir', () => {
  registerSubAgent('child', entry('child', 'parent'), undefined);
  assert.equal(resolveSubAgent('child', undefined), undefined);
});

test('removeSubAgentsOfSession removes children and grandchildren of that session only', () => {
  withTempDir((dir) => {
    registerSubAgent('child', entry('child', 'parent'), dir);
    registerSubAgent('grandchild', entry('grandchild', 'child'), dir);
    registerSubAgent('other-child', entry('other-child', 'other-parent'), dir);
    removeSubAgentsOfSession('parent', dir);
    assert.equal(resolveSubAgent('child', dir), undefined);
    assert.equal(resolveSubAgent('grandchild', dir), undefined);
    assert.equal(resolveSubAgent('other-child', dir)?.rootSessionId, 'other-parent');
  });
});

test('resolveCaller: top-level session uses its own id', () => {
  withTempDir((dir) => {
    const caller = resolveCaller('agent-1', { session_id: 'parent' }, dir);
    assert.equal(caller.isSubAgent, false);
    assert.equal(caller.sessionId, 'parent');
    assert.equal('hops' in caller, false);
  });
});

test('resolveCaller: registered Copilot subagent maps to the root session as SubAgent', () => {
  withTempDir((dir) => {
    registerSubAgent('child', entry('child', 'parent'), dir);
    const caller = resolveCaller('agent-1', { session_id: 'child' }, dir);
    assert.equal(caller.isSubAgent, true);
    assert.equal(caller.subAgentId, 'child');
    assert.equal(caller.subAgentType, 'explore');
    assert.equal(caller.sessionId, 'parent');
    assert.equal('hops' in caller, false);
  });
});

test('resolveCaller: Claude-style agent_id keeps the shared session', () => {
  withTempDir((dir) => {
    const caller = resolveCaller('agent-1', { session_id: 'session-1', agent_id: 'sub-1', agent_type: 'Explore' }, dir);
    assert.equal(caller.isSubAgent, true);
    assert.equal(caller.subAgentId, 'sub-1');
    assert.equal(caller.sessionId, 'session-1');
  });
});

test('an entry written before hops were removed still resolves (extra lineage field ignored)', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'subagents', 'child.json'),
      JSON.stringify({ ...entry('child', 'parent'), lineage: [{ seq: 1 }] }),
      'utf8',
    );
    assert.equal(resolveSubAgent('child', dir)?.rootSessionId, 'parent');
  });
});

test('normalizeUserPrompt picks up Copilot subagent kickoff fields', () => {
  const input = normalizeUserPrompt({
    sessionId: 'child',
    agentId: 'child',
    agentType: 'explore',
    parentAgentId: 'parent',
    cwd: '/tmp',
    prompt: 'task',
  });
  assert.equal(input.agent_id, 'child');
  assert.equal(input.agent_type, 'explore');
  assert.equal(input.parent_agent_id, 'parent');
});

test('normalizeUserPrompt leaves subagent fields unset for a human prompt', () => {
  const input = normalizeUserPrompt({ sessionId: 'parent', cwd: '/tmp', prompt: 'hi' });
  assert.equal(input.agent_id, undefined);
  assert.equal(input.parent_agent_id, undefined);
});
