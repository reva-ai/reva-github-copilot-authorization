import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// Real compiled prompt hook, real subprocess, a stand-in Reva (evaluation +
// ingestion), and a Copilot home holding a session record like the one
// Copilot writes on macOS.
const AUTHORIZE_PROMPT = path.join(__dirname, '..', 'src', 'authorizePrompt.js');
const SESSION = 'mac-session-1';

interface Seen {
  evaluations: any[];
  patches: any[];
}

async function withReva(fn: (host: string, seen: Seen) => Promise<void>): Promise<void> {
  const seen: Seen = { evaluations: [], patches: [] };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.url?.includes('/ai/evaluation')) {
        seen.evaluations.push(JSON.parse(data));
        return reply(200, { decision: true });
      }
      if (req.url?.includes('/policy-store/entity-types')) {
        return reply(200, [
          { id: 'user-type', name: 'User', schemaName: 'CodingAgent' },
          { id: 'agent-type', name: 'Agent', schemaName: 'CodingAgent' },
          { id: 'mcp-type', name: 'MCPServer', schemaName: 'CodingAgent' },
        ]);
      }
      if (req.method === 'PATCH') seen.patches.push(JSON.parse(data));
      return reply(200, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

function runPrompt(host: string, dirs: { data: string; home: string; copilotHome: string }, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUTHORIZE_PROMPT], {
      env: {
        PATH: process.env.PATH || '',
        HOME: dirs.home,
        USERPROFILE: dirs.home,
        COPILOT_HOME: dirs.copilotHome,
        REVA_HOST: host,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'dev',
        REVA_USER_EMAIL: 'dev@example.com',
        COPILOT_PLUGIN_DATA: dirs.data,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin.end(JSON.stringify({ sessionId: SESSION, cwd: dirs.data, prompt: 'list me files', timestamp: 1 }));
  });
}

async function withDirs(fn: (dirs: { data: string; home: string; copilotHome: string }) => Promise<void>): Promise<void> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-model-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-model-home-'));
  const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-model-copilot-'));
  const sessionDir = path.join(copilotHome, 'session-state', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'events.jsonl'),
    [
      { type: 'session.model_change', data: { cause: 'initial_resolution', newModel: 'auto' } },
      { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-6-luna', routingMethod: 'auto_v2' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  try {
    await fn({ data, home, copilotHome });
  } finally {
    for (const d of [data, home, copilotHome]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('the prompt request carries the model and Agent.models records it', async () => {
  await withDirs(async (dirs) => {
    await withReva(async (host, seen) => {
      await runPrompt(host, dirs);
      assert.equal(seen.evaluations.length, 1);
      assert.equal(seen.evaluations[0].context.model, 'gpt-6-luna');
      assert.deepEqual(
        seen.patches.filter((p) => p.attributeValue?.name === 'models').map((p) => p.attributeValue.value),
        ['gpt-6-luna'],
      );
    });
  });
});

test('REVA_MODEL_CONTEXT is no longer read: setting it to 0 still sends the model', async () => {
  await withDirs(async (dirs) => {
    await withReva(async (host, seen) => {
      await runPrompt(host, dirs, { REVA_MODEL_CONTEXT: '0' });
      assert.equal(seen.evaluations[0].context.model, 'gpt-6-luna');
    });
  });
});
