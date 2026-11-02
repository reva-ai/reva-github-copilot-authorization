import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { toolSpanKey } from '../src/trace';

// Real compiled pre/post entrypoints against a local stand-in RTG: one span
// per resource, and each resource's pre and post meet on the same span.
const DIST_SRC = path.join(__dirname, '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO = path.basename(REPO_ROOT);

type Captured = { body: any; span: string; trace: string };

async function withRtg(fn: (host: string, captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url?.includes('/ai/evaluation')) {
        const [, trace, span] = String(req.headers.traceparent || '').split('-');
        captured.push({ body: JSON.parse(data), span, trace });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url?.includes('/ai/evaluation') ? JSON.stringify({ decision: true }) : '[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`127.0.0.1:${(server.address() as AddressInfo).port}`, captured);
  } finally {
    server.close();
  }
}

function runHook(entry: string, payload: object, host: string, dataDir: string, home: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST_SRC, entry)], {
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        USERPROFILE: home,
        REVA_HOST: host,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'dev',
        REVA_USER_EMAIL: 'dev@example.com',
        COPILOT_PLUGIN_DATA: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withDirs(fn: (dataDir: string, home: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-span-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-span-home-'));
  try {
    await fn(dataDir, home);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('toolSpanKey differs per resource and ignores resource type', () => {
  const input = { command: 'rm a.txt b.txt' };
  const a = toolSpanKey('bash', input, { actionName: 'executeBash', resourceId: 'r/a.txt' });
  const b = toolSpanKey('bash', input, { actionName: 'executeBash', resourceId: 'r/b.txt' });
  assert.notEqual(a, b);
  assert.equal(a, toolSpanKey('bash', input, { actionName: 'executeBash', resourceId: 'r/a.txt' }));
  assert.notEqual(a, toolSpanKey('bash', input, { actionName: 'write', resourceId: 'r/a.txt' }));
});

test('pre and post send the same prompt; the tool output travels in transmission.response', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(async (host, captured) => {
      const command = 'cat alpha-prompt.txt';
      const base = { sessionId: 'prompt-s1', cwd: REPO_ROOT, toolName: 'bash', toolArgs: { command } };
      assert.equal(await runHook('authorize.js', base, host, dataDir, home), 0);
      const output = { resultType: 'success', textResultForLlm: 'alpha contents' };
      assert.equal(await runHook('authorizePost.js', { ...base, toolResult: output }, host, dataDir, home), 0);

      assert.equal(captured.length, 2);
      const [pre, post] = captured.map((c) => c.body.transmission);
      assert.equal(pre.userQuery, command);
      assert.equal(post.userQuery, pre.userQuery, 'post prompt matches pre');
      assert.equal(pre.response, undefined);
      assert.equal(post.response, 'alpha contents');
      assert.equal(post.role, 'tool');
      assert.equal(post.contentType, 'text/plain');
    });
  });
});

test('a two-path command: one span per resource, and each pre/post pair shares its span', async () => {
  await withDirs(async (dataDir, home) => {
    await withRtg(async (host, captured) => {
      const toolArgs = { command: 'cat alpha-span.txt beta-span.txt' };
      const base = { sessionId: 'span-s1', cwd: REPO_ROOT, toolName: 'bash', toolArgs };
      assert.equal(await runHook('authorize.js', base, host, dataDir, home), 0);
      const pre = captured.splice(0);
      assert.equal(await runHook('authorizePost.js', { ...base, toolResult: { resultType: 'success', textResultForLlm: 'ok' } }, host, dataDir, home), 0);
      const post = captured.splice(0);

      const spansOf = (rows: Captured[]) => new Map(rows.map((c) => [c.body.resource.id, c.span]));
      const preSpans = spansOf(pre);
      assert.deepEqual([...preSpans.keys()].sort(), [`${REPO}/alpha-span.txt`, `${REPO}/beta-span.txt`]);
      assert.equal(new Set(preSpans.values()).size, 2, 'each resource gets its own span');
      assert.deepEqual(spansOf(post), preSpans, 'post pairs with pre, resource by resource');
      assert.equal(new Set([...pre, ...post].map((c) => c.trace)).size, 1, 'all under one trace');
    });
  });
});
