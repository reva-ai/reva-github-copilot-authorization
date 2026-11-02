import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizePreToolUse } from '../src/normalize';
import { parseApplyPatchTargets, patchTextOf } from '../src/applyPatch';
import { mapToolCall } from '../src/mapping';

// The repo root this test runs in (has .git), so ids are portable.
const cwd = path.resolve(__dirname, '..', '..');
const repo = path.basename(cwd);

// The shape Copilot CLI sends: toolArgs is the bare patch string, not JSON.
const LIVE_DELETE_PAYLOAD = {
  sessionId: 's',
  cwd,
  toolName: 'apply_patch',
  toolArgs: '*** Begin Patch\n*** Delete File: tests/test.js\n*** End Patch\n',
};

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
}

test('live Copilot delete payload maps to write on the exact file', () => {
  const input = normalizePreToolUse(LIVE_DELETE_PAYLOAD);
  assert.deepEqual(input.tool_input, { raw: LIVE_DELETE_PAYLOAD.toolArgs });

  const { mappings } = mapToolCall(input.tool_name, input.tool_input, input.cwd);
  assert.equal(mappings.length, 1);
  const m = mappings[0];
  assert.equal(m.actionName, 'write');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.resourceId, `${repo}/tests/test.js`);
  assert.deepEqual(m.resourceProperties, { name: 'test.js', extension: 'js' });
  assert.deepEqual(m.resourceParents, [
    { type: 'Directory', id: `${repo}/tests` },
    { type: 'Directory', id: repo },
    { type: 'Repository', id: repo },
  ]);
  assert.equal(m.tool, 'apply_patch');
  assert.equal(m.command, undefined, 'a file action carries no command');
});

test('Add → write, Update → edit, Delete → write', () => {
  const targets = parseApplyPatchTargets(
    patch('*** Add File: src/new.ts', '+x', '*** Update File: src/old.ts', '@@', '-a', '+b', '*** Delete File: src/gone.ts'),
    cwd,
  );
  assert.deepEqual(
    targets.map((t) => [t.actionName, path.relative(cwd, t.absolutePath).split(path.sep).join('/')]),
    [
      ['write', 'src/new.ts'],
      ['edit', 'src/old.ts'],
      ['write', 'src/gone.ts'],
    ],
  );
});

test('Move → write on the source and write on the destination', () => {
  const { mappings } = mapToolCall(
    'apply_patch',
    { raw: patch('*** Update File: src/a.ts', '*** Move to: lib/b.ts', '@@', '-x', '+y') },
    cwd,
  );
  assert.deepEqual(
    mappings.map((m) => [m.actionName, m.resourceId]),
    [
      ['write', `${repo}/src/a.ts`],
      ['write', `${repo}/lib/b.ts`],
    ],
  );
});

test('the same file updated twice is one resource', () => {
  const targets = parseApplyPatchTargets(patch('*** Update File: a.ts', '@@', '*** Update File: a.ts', '@@'), cwd);
  assert.equal(targets.length, 1);
});

test('Windows line endings in the patch are handled', () => {
  const targets = parseApplyPatchTargets('*** Begin Patch\r\n*** Delete File: tests/test.js\r\n*** End Patch\r\n', cwd);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].actionName, 'write');
});

test('an unreadable patch yields no mappings (hooks fail closed on that)', () => {
  assert.deepEqual(mapToolCall('apply_patch', { raw: 'not a patch' }, cwd).mappings, []);
  assert.deepEqual(mapToolCall('apply_patch', {}, cwd).mappings, []);
});

test('patch text is read from raw, input, patch or command', () => {
  const p = patch('*** Delete File: x.js');
  for (const key of ['raw', 'input', 'patch', 'command']) assert.equal(patchTextOf({ [key]: p }), p);
});

test('every other tool still maps to exactly one resource, unchanged', () => {
  const ps = mapToolCall('powershell', { command: 'Remove-Item D:\\test.file.js' }, cwd);
  assert.equal(ps.mappings.length, 1);
  assert.equal(ps.mappings[0].actionName, 'executeBash');
  assert.equal(ps.mappings[0].command, 'Remove-Item D:\\test.file.js');
  assert.equal(mapToolCall('edit', { path: 'a.ts' }, cwd).mappings[0].actionName, 'edit');
});
