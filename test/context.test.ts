import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActionContext,
  buildInvokeAgentContext,
  osAttribute,
} from '../src/context';
import { CedarActionMapping } from '../src/types';

const CONTEXT_KEYS = [
  'activeSessionCount',
  'sessionId',
  'sessionEntryPoint',
  'sessionLastSeen',
  'agentType',
  'machineId',
  'os',
  'hops',
  'timestamp',
].sort();

test('invokeAgent context includes session scalars, agentType GitHubCopilot, machineId, and os', () => {
  const ctx = buildInvokeAgentContext();
  assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
  assert.deepEqual(ctx.hops, []);
  assert.equal(ctx.agentType, 'GitHubCopilot');
  assert.equal(ctx.machineId, '');
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

test('model is sent only when modelContext is on', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  assert.equal('model' in buildActionContext(mapping, { model: 'gpt-6-luna' }), false);
  assert.equal(buildActionContext(mapping, { model: 'gpt-6-luna', modelContext: true }).model, 'gpt-6-luna');
  assert.equal(buildActionContext(mapping, { modelContext: true }).model, '');
  assert.equal(buildInvokeAgentContext(0, undefined, undefined, { model: 'claude-sonnet-5.5', modelContext: true }).model, 'claude-sonnet-5.5');
  assert.equal('model' in buildInvokeAgentContext(0, undefined, undefined, { model: 'claude-sonnet-5.5' }), false);
});

test('os is present on every action, using the real current platform', () => {
  const mapping: CedarActionMapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
  const expected = osAttribute();
  assert.equal(buildActionContext(mapping).os, expected);
  assert.equal(buildInvokeAgentContext().os, expected);
});
