import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateAssistantOutput } from '../src/assistantOutput';

const MAX = 16 * 1024;

test('empty, blank and missing input give an empty string', () => {
  assert.equal(truncateAssistantOutput(undefined), '');
  assert.equal(truncateAssistantOutput(null), '');
  assert.equal(truncateAssistantOutput(''), '');
  assert.equal(truncateAssistantOutput('  \n\t '), '');
});

test('text within the budget is returned trimmed and unchanged', () => {
  assert.equal(truncateAssistantOutput('  Done: 3 files changed.\n'), 'Done: 3 files changed.');
  const exactly = 'a'.repeat(MAX);
  assert.equal(truncateAssistantOutput(exactly), exactly);
});

test('text over the budget is cut to 16 KiB of UTF-8', () => {
  const out = truncateAssistantOutput('b'.repeat(MAX + 500));
  assert.equal(Buffer.byteLength(out, 'utf8'), MAX);
});

test('a cut through a multi-byte character leaves no replacement character', () => {
  // 3-byte characters: 16384 is not a multiple of 3, so the cut lands mid-character.
  const out = truncateAssistantOutput('€'.repeat(10000));
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX);
  assert.equal(out.includes('\uFFFD'), false);
  assert.ok(out.length > 0 && [...out].every((c) => c === '€'));
});
