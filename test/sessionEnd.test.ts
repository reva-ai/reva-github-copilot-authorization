import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getActiveSessionCount, markSessionActive } from '../src/activeSessions';

const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionEnd.js');

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-session-end-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSessionEnd(stdin: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: stdin,
    env: { PATH: process.env.PATH || '', ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout };
}

test('valid input, no REVA_AGENT_ID: exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd(JSON.stringify({ sessionId: 's1', cwd: '/tmp' }));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('malformed JSON on stdin: still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd('{ not valid json');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('sessionEnd removes the session from the active-sessions registry (snake_case session_id)', () => {
  withTempDir((dir) => {
    markSessionActive('agent-real', 'sess-1', 'cli', dir);
    assert.equal(getActiveSessionCount('agent-real', dir), 1);

    const { status } = runSessionEnd(JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }), {
      REVA_AGENT_ID: 'agent-real',
      COPILOT_PLUGIN_DATA: dir,
    });

    assert.equal(status, 0);
    assert.equal(getActiveSessionCount('agent-real', dir), 0);
  });
});

test('sessionEnd accepts camelCase sessionId', () => {
  withTempDir((dir) => {
    markSessionActive('agent-real', 'sess-camel', 'cli', dir);

    runSessionEnd(JSON.stringify({ sessionId: 'sess-camel', cwd: '/tmp' }), {
      REVA_AGENT_ID: 'agent-real',
      PLUGIN_DATA: dir,
    });

    assert.equal(getActiveSessionCount('agent-real', dir), 0);
  });
});
