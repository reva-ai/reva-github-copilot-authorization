import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePreToolUse, normalizeUserPrompt } from '../src/normalize';

describe('normalize payloads', () => {
  it('accepts Copilot camelCase preToolUse', () => {
    const n = normalizePreToolUse({
      sessionId: 's1',
      cwd: '/tmp',
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: 'echo hi' }),
    });
    assert.equal(n.session_id, 's1');
    assert.equal(n.tool_name, 'bash');
    assert.equal(n.tool_input.command, 'echo hi');
  });

  it('accepts snake_case PreToolUse', () => {
    const n = normalizePreToolUse({
      session_id: 's2',
      cwd: '/tmp',
      tool_name: 'view',
      tool_input: { path: 'a.ts' },
    });
    assert.equal(n.session_id, 's2');
    assert.equal(n.tool_name, 'view');
    assert.equal(n.tool_input.path, 'a.ts');
  });

  it('normalizes user prompt', () => {
    const n = normalizeUserPrompt({ sessionId: 's3', prompt: 'hello', cwd: '/tmp' });
    assert.equal(n.prompt, 'hello');
    assert.equal(n.session_id, 's3');
  });
});
