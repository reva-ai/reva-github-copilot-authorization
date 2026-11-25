import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openCircuit } from '../src/rtgCircuitBreaker';
import { registerSubAgent } from '../src/subAgentRegistry';

// Runs the real compiled hooks as subprocesses against a local stand-in for
// Reva: the prompt hook opens a turn, then the Stop hook closes its trace.

const DIST_SRC = path.join(__dirname, '..', 'src');
const SESSION = '5b0f6e2c-3d11-4c53-9f0e-7d6f1c2a9b10';

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

async function withRtg(
  summarizeStatus: number,
  fn: (host: string, evaluations: Captured[], summaries: Captured[]) => Promise<void>,
): Promise<void> {
  const evaluations: Captured[] = [];
  const summaries: Captured[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const entry = { url: req.url || '', headers: req.headers, body: data ? JSON.parse(data) : undefined };
      if (entry.url.includes('/ai/trace/summarize')) {
        summaries.push(entry);
        res.writeHead(summarizeStatus, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (entry.url.includes('/ai/evaluation')) evaluations.push(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(entry.url.includes('/ai/evaluation') ? JSON.stringify({ decision: true }) : '[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`127.0.0.1:${port}`, evaluations, summaries);
  } finally {
    server.close();
  }
}

function runHook(script: string, stdin: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST_SRC, script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.end(stdin);
  });
}

function hookEnv(host: string, dataDir: string, home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '',
    // Isolate from the developer's real ~/.copilot/settings.json (token/host).
    HOME: home,
    USERPROFILE: home,
    REVA_HOST: host,
    REVA_AUTH_TOKEN: 'test-token',
    REVA_AGENT_ID: 'dev',
    REVA_USER_EMAIL: 'dev@example.com',
    COPILOT_PLUGIN_DATA: dataDir,
    ...extra,
  };
}

async function withDirs(fn: (dataDir: string, home: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-stop-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-stop-home-'));
  try {
    await fn(dataDir, home);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function startTurn(env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number | null; stdout: string }> {
  return runHook('authorizePrompt.js', JSON.stringify({ sessionId: SESSION, cwd, prompt: 'fix the bug', timestamp: 1 }), env);
}

const agentStop = (cwd: string, extra: object = {}) =>
  JSON.stringify({
    sessionId: SESSION,
    timestamp: 2,
    cwd,
    transcriptPath: path.join(cwd, 'events.jsonl'),
    stopReason: 'end_turn',
    stop_hook_active: false,
    ...extra,
  });

test('agentStop closes the turn trace: summarize carries the turn trace id and the thread id', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      assert.equal((await startTurn(env, dataDir)).status, 0);
      await runHook('authorize.js', JSON.stringify({ sessionId: SESSION, cwd: dataDir, toolName: 'glob', toolArgs: { pattern: '*.ts' } }), env);

      const stop = await runHook('stop.js', agentStop(dataDir), env);
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '', 'a Stop hook must emit no decision — anything would be read as block');

      assert.equal(summaries.length, 1);
      const [summary] = summaries;
      const turnTrace = evaluations[0].headers.traceparent?.toString().split('-')[1];
      assert.match(turnTrace || '', /^[0-9a-f]{32}$/);
      assert.equal(summary.body.trace_id, turnTrace, 'same trace id as the evaluations of this turn');
      for (const e of evaluations) assert.equal(e.headers.traceparent?.toString().split('-')[1], turnTrace);
      assert.equal(summary.body.thread_id, SESSION);
      assert.equal(summary.headers['x-reva-thread-id'], SESSION);
      assert.equal(summary.headers['x-api-token'], 'test-token');
      assert.equal(summary.headers['x-api-origin-app'], 'GITHUB_COPILOT');
      assert.equal(summary.headers['x-reva-verification-codes'], undefined);
      assert.equal('output' in summary.body, false, 'agentStop carries no reply, so none is sent');
    });
  });
});

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

test('the prompt reaches Reva (capped at 10,000 characters) and is stored nowhere on the machine', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, evaluations) => {
      const env = hookEnv(host, dataDir, home);
      const marker = 'MARKER-prompt-text-do-not-store-9f3a1c';
      const long = `${marker} ${'z'.repeat(12000)}`;
      const prompt = await runHook(
        'authorizePrompt.js',
        JSON.stringify({ sessionId: SESSION, cwd: dataDir, prompt: long, timestamp: 1 }),
        env,
      );
      assert.equal(prompt.status, 0);
      await runHook('authorize.js', JSON.stringify({ sessionId: SESSION, cwd: dataDir, toolName: 'glob', toolArgs: { pattern: '*.ts' } }), env);
      await runHook('stop.js', agentStop(dataDir), env);

      // Sent to Reva: the first 10,000 characters, with the cut marked.
      const userQuery: string = evaluations[0].body.transmission.userQuery;
      assert.equal(userQuery, `${long.slice(0, 10000)}…`);

      // Stored locally: none of it, in any file the plugin wrote.
      assert.ok(filesUnder(dataDir).length > 0, 'the hooks did write state, so the scan is meaningful');
      for (const file of filesUnder(dataDir)) {
        assert.equal(fs.readFileSync(file, 'utf8').includes(marker), false, `${file} must not hold prompt text`);
      }
    });
  });
});

test('the next prompt starts a new trace, and its Stop summarizes that one', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      await runHook('stop.js', agentStop(dataDir), env);
      await startTurn(env, dataDir);
      await runHook('stop.js', agentStop(dataDir), env);
      assert.equal(summaries.length, 2);
      assert.notEqual(summaries[0].body.trace_id, summaries[1].body.trace_id);
    });
  });
});

test('the VS Code snake_case Stop payload works too, and a supplied reply is sent as output', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      const stop = await runHook(
        'stop.js',
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: SESSION,
          timestamp: '2026-11-06T10:00:00.000Z',
          cwd: dataDir,
          transcript_path: path.join(dataDir, 'transcript.jsonl'),
          stop_reason: 'end_turn',
          stop_hook_active: false,
          last_assistant_message: '  Fixed the bug in parser.ts.  ',
        }),
        env,
      );
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '');
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].body.output, 'Fixed the bug in parser.ts.');
    });
  });
});

test('a reply over 16 KiB is truncated before it is sent', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      await runHook('stop.js', agentStop(dataDir, { response: 'x'.repeat(40000) }), env);
      assert.equal(summaries.length, 1);
      assert.equal(Buffer.byteLength(summaries[0].body.output, 'utf8'), 16 * 1024);
    });
  });
});

test('a failing summarize never blocks: exit 0, no output', async () => {
  for (const status of [400, 401, 500]) {
    await withDirs(async (dataDir, home) => {
      await withRtg(status, async (host, _evaluations, summaries) => {
        const env = hookEnv(host, dataDir, home);
        await startTurn(env, dataDir);
        const stop = await runHook('stop.js', agentStop(dataDir), env);
        assert.equal(summaries.length, 1);
        assert.equal(stop.status, 0, `HTTP ${status}`);
        assert.equal(stop.stdout, '');
      });
    });
  }
});

test('an unreachable Reva never blocks either', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      const stop = await runHook('stop.js', agentStop(dataDir), { ...env, REVA_HOST: '127.0.0.1:1' });
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '');
    });
  });
});

test('no turn on record: nothing to close, no request', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const stop = await runHook('stop.js', agentStop(dataDir), hookEnv(host, dataDir, home));
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '');
      assert.equal(summaries.length, 0);
    });
  });
});

test('plugin not configured: exits 0 and sends nothing', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      const { REVA_AUTH_TOKEN: _token, ...noToken } = env;
      const stop = await runHook('stop.js', agentStop(dataDir), noToken);
      assert.equal(stop.status, 0);
      assert.equal(stop.stdout, '');
      assert.equal(summaries.length, 0);
    });
  });
});

test('after a 401 latched the session, Stop does not call Reva', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      openCircuit(SESSION, 401, 'USER_NOT_FOUND', dataDir);
      const stop = await runHook('stop.js', agentStop(dataDir), env);
      assert.equal(stop.status, 0);
      assert.equal(summaries.length, 0);
    });
  });
});

test('a registered subagent session has no turn to close', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      await startTurn(env, dataDir);
      registerSubAgent(
        SESSION,
        { subAgentId: SESSION, parentSessionId: 'some-parent', agentType: 'explore', registeredAt: '2026-01-01T00:00:00.000Z' },
        dataDir,
      );
      const stop = await runHook('stop.js', agentStop(dataDir), env);
      assert.equal(stop.status, 0);
      assert.equal(summaries.length, 0);
    });
  });
});

test('malformed or empty stdin: still exits 0 with empty stdout', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(202, async (host, _evaluations, summaries) => {
      const env = hookEnv(host, dataDir, home);
      for (const stdin of ['{ not valid json', '']) {
        const stop = await runHook('stop.js', stdin, env);
        assert.equal(stop.status, 0);
        assert.equal(stop.stdout, '');
      }
      assert.equal(summaries.length, 0);
    });
  });
});

test('hooks.json registers the stop hook on agentStop with a short timeout', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = manifest.hooks.agentStop;
  assert.equal(entry.type, 'command');
  assert.equal(entry.bash, 'node dist/src/stop.js');
  assert.equal(entry.powershell, 'node dist/src/stop.js');
  assert.ok(entry.timeoutSec <= 10);
  assert.ok(fs.existsSync(path.join(DIST_SRC, 'stop.js')));
});
