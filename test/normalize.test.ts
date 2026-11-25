import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePreToolUse, normalizeStop, normalizeUserPrompt } from '../src/normalize';

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

describe('normalize agentStop / Stop', () => {
  it('accepts the Copilot CLI camelCase agentStop payload', () => {
    const n = normalizeStop({
      sessionId: 's1',
      timestamp: 1790000000000,
      cwd: '/tmp',
      transcriptPath: '/home/u/.copilot/session-state/s1/events.jsonl',
      stopReason: 'end_turn',
      stop_hook_active: false,
    });
    assert.equal(n.session_id, 's1');
    assert.equal(n.cwd, '/tmp');
    assert.equal(n.hook_event_name, 'agentStop');
    assert.equal(n.transcript_path, '/home/u/.copilot/session-state/s1/events.jsonl');
    assert.equal(n.stop_hook_active, false);
    assert.equal(n.last_assistant_message, undefined);
  });

  it('accepts the VS Code snake_case Stop payload', () => {
    const n = normalizeStop({
      hook_event_name: 'Stop',
      session_id: 's2',
      timestamp: '2026-11-06T10:00:00.000Z',
      cwd: '/tmp',
      transcript_path: 'C:\\Users\\u\\transcript.jsonl',
      stop_reason: 'end_turn',
      stop_hook_active: true,
    });
    assert.equal(n.session_id, 's2');
    assert.equal(n.hook_event_name, 'Stop');
    assert.equal(n.transcript_path, 'C:\\Users\\u\\transcript.jsonl');
    assert.equal(n.stop_hook_active, true);
  });

  it('reads the reply only under the names Copilot documents for subagentStop', () => {
    assert.equal(normalizeStop({ sessionId: 's', response: 'all done' }).last_assistant_message, 'all done');
    assert.equal(normalizeStop({ session_id: 's', last_assistant_message: 'all done' }).last_assistant_message, 'all done');
  });

  it('never fails on an empty payload', () => {
    const n = normalizeStop({});
    assert.equal(n.session_id, 'unknown-session');
    assert.equal(n.transcript_path, undefined);
  });
});
