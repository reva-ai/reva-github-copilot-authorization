import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActionContext,
  buildInvokeAgentContext,
  osAttribute,
  truncatePrompt,
} from '../src/context';
import { CedarActionMapping } from '../src/types';

// One cap on the prompt sent as invokeAgent userQuery, the same in every Reva plugin.
test('truncatePrompt caps a prompt at 10,000 characters and marks the cut', () => {
  const long = 'x'.repeat(10001);
  const truncated = truncatePrompt(long);
  assert.equal(truncated, `${'x'.repeat(10000)}…`);
});

test('truncatePrompt keeps a prompt of exactly 10,000 characters whole, and short prompts untouched', () => {
  const exact = 'y'.repeat(10000);
  assert.equal(truncatePrompt(exact), exact);
  assert.equal(truncatePrompt('short prompt'), 'short prompt');
});

const CONTEXT_KEYS = [
  'activeSessionCount',
  'sessionId',
  'sessionEntryPoint',
  'sessionLastSeen',
  'agentType',
  'machineId',
  'os',
  'model',
  'timestamp',
].sort();

test('invokeAgent context includes session scalars, agentType GitHubCopilot, machineId, os, and model', () => {
  const ctx = buildInvokeAgentContext();
  assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
  assert.equal(ctx.agentType, 'GitHubCopilot');
  assert.equal(ctx.machineId, '');
});

// Reva records a trace's hops and a thread's earlier prompts itself; if the
// plugin supplied them Reva would keep ours and not attach what it recorded.
test('no action context carries hops or conversation history', () => {
  const actions: CedarActionMapping[] = [
    { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' },
    { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'explore' },
    { actionName: 'executeBash', resourceType: 'File', resourceId: '/repo/a.ts', command: 'ls' },
    { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' },
    { actionName: 'write', resourceType: 'File', resourceId: '/repo/a.ts' },
    { actionName: 'edit', resourceType: 'File', resourceId: '/repo/a.ts' },
    { actionName: 'glob', resourceType: 'Folder', resourceId: '/repo' },
    { actionName: 'grep', resourceType: 'Folder', resourceId: '/repo' },
  ];
  for (const mapping of actions) {
    const ctx = buildActionContext(mapping, { subagentIndex: 2 });
    for (const key of ['hops', 'conversation', 'messages']) {
      assert.equal(key in ctx, false, `${mapping.actionName} must not send context.${key}`);
    }
  }
});

test('machineId is carried through when the caller provides it', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  assert.equal(buildActionContext(mapping, { machineId: 'machine-xyz' }).machineId, 'machine-xyz');
  assert.equal(buildInvokeAgentContext(0, undefined, 'machine-xyz').machineId, 'machine-xyz');
});

test('osAttribute reports Windows, macOS, and Linux for other Unix-likes', () => {
  assert.equal(osAttribute('win32'), 'Windows');
  assert.equal(osAttribute('darwin'), 'macOS');
  for (const unixLike of ['linux', 'freebsd'] as const) {
    assert.equal(osAttribute(unixLike), 'Linux');
  }
});

test('model is always sent, empty when it cannot be read', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  assert.equal(buildActionContext(mapping, { model: 'gpt-6-luna' }).model, 'gpt-6-luna');
  assert.equal(buildActionContext(mapping).model, '');
  assert.equal(buildInvokeAgentContext(0, undefined, undefined, { model: 'claude-sonnet-5.5' }).model, 'claude-sonnet-5.5');
  assert.equal(buildInvokeAgentContext(0).model, '');
});

test('os is present on every action, using the real current platform', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  const expected = osAttribute();
  assert.equal(buildActionContext(mapping).os, expected);
  assert.equal(buildInvokeAgentContext().os, expected);
});
