import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveSubAgent } from '../src/subAgentRegistry';

// Replays the hook sequence Copilot CLI actually sent for a 4-subagent
// prompt (captured from ~/.copilot/session-state/<id>/events.jsonl):
//   parent userPromptSubmitted → 4× preToolUse(task) under the parent id →
//   each child's userPromptSubmitted under ITS OWN sessionId with
//   agentId/agentType/parentAgentId → the children's tool calls under their
//   own sessionIds with no agent fields at all.
// Real compiled entrypoints, real subprocesses, a local stand-in RTG.

const DIST_SRC = path.join(__dirname, '..', 'src');
const PARENT = '39eb41ae-2e1f-4847-a8c2-d2417352c144';
const CHILDREN = [
  '373f3991-7fdc-4314-9a0d-e09c91e93c0c',
  '9d295b18-28b0-48df-8744-fbb1d7d5dbde',
  '7a0c9fbc-0a30-4b81-8acf-7198d73a6bab',
  '18ec293e-3f6f-4c96-a62e-52d9ff62fa7b',
];
const GRANDCHILD = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Captured {
  body: any;
  traceparent?: string;
}

async function withRtg(fn: (host: string, captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url?.includes('/ai/evaluation')) {
        captured.push({ body: JSON.parse(data), traceparent: req.headers.traceparent as string });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`127.0.0.1:${port}`, captured);
  } finally {
    server.close();
  }
}

function runHook(script: string, payload: object, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIST_SRC, script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function hookEnv(host: string, dataDir: string, home: string): NodeJS.ProcessEnv {
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
  };
}

function traceIdOf(traceparent?: string): string | undefined {
  return traceparent?.split('-')[1];
}

test('Copilot subagents land in the parent session as SubAgent subjects with their spawn lineage', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-subagent-flow-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-subagent-home-'));
  try {
    await withRtg(async (host, captured) => {
      const env = hookEnv(host, dataDir, home);
      const cwd = dataDir;

      // 1. The human's prompt.
      await runHook('authorizePrompt.js', { sessionId: PARENT, cwd, prompt: 'Analyze with 4 subagents', timestamp: 1 }, env);

      // 2. Four task spawns under the parent (Copilot runs the hook once per call).
      for (const name of ['ts-files', 'syntax-check', 'unused-imports', 'code-improvements']) {
        const r = await runHook(
          'authorize.js',
          { sessionId: PARENT, cwd, toolName: 'task', toolArgs: { name, agent_type: 'explore', mode: 'background', prompt: name } },
          env,
        );
        assert.equal(r.status, 0);
        assert.equal(JSON.parse(r.stdout).permissionDecision, 'allow');
      }

      // 3. Each child's kickoff, under its own sessionId.
      for (const child of CHILDREN) {
        const r = await runHook(
          'authorizePrompt.js',
          { sessionId: child, agentId: child, agentType: 'explore', parentAgentId: PARENT, cwd, prompt: 'model-written task', timestamp: 2 },
          env,
        );
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '', 'kickoff emits no decision');
      }

      // 4. Child tool calls carry only the child sessionId.
      await runHook('authorize.js', { sessionId: CHILDREN[1], cwd, toolName: 'powershell', toolArgs: { command: 'Get-ChildItem' } }, env);
      await runHook(
        'authorizePost.js',
        { sessionId: CHILDREN[1], cwd, toolName: 'powershell', toolArgs: { command: 'Get-ChildItem' }, toolResult: { textResultForLlm: 'ok' } },
        env,
      );
      await runHook('authorize.js', { sessionId: CHILDREN[3], cwd, toolName: 'glob', toolArgs: { pattern: '**/*.ts' } }, env);

      // 5. A child spawns a grandchild, which then makes a call.
      await runHook('authorize.js', { sessionId: CHILDREN[0], cwd, toolName: 'task', toolArgs: { name: 'nested', agent_type: 'explore', prompt: 'x' } }, env);
      await runHook(
        'authorizePrompt.js',
        { sessionId: GRANDCHILD, agentId: GRANDCHILD, agentType: 'explore', parentAgentId: CHILDREN[0], cwd, prompt: 'nested task', timestamp: 3 },
        env,
      );
      await runHook('authorize.js', { sessionId: GRANDCHILD, cwd, toolName: 'view', toolArgs: { path: 'README.md' } }, env);

      // 6. The parent checks on its subagents.
      await runHook('authorize.js', { sessionId: PARENT, cwd, toolName: 'read_agent', toolArgs: { agent_id: CHILDREN[1] } }, env);
      await runHook('authorize.js', { sessionId: PARENT, cwd, toolName: 'list_agents', toolArgs: {} }, env);

      const bodies = captured.map((c) => c.body);

      // Only the human's prompt is an invokeAgent — no kickoff was evaluated as one.
      const invokes = bodies.filter((b) => b.action.name === 'invokeAgent');
      assert.equal(invokes.length, 1);
      assert.equal(invokes[0].transmission.userQuery, 'Analyze with 4 subagents');

      // Every request is in the parent session…
      for (const b of bodies) assert.equal(b.session.id, PARENT);

      // …the parent's own work (prompt, spawns, read_agent/list_agents) on
      // the turn's trace, and each subagent on a trace of its own.
      const traceOfSubject = (subjectId: string) => {
        const ids = new Set(captured.filter((c) => c.body.subject.id === subjectId).map((c) => traceIdOf(c.traceparent)));
        assert.equal(ids.size, 1, `${subjectId} spans one trace`);
        return [...ids][0];
      };
      const parentCalls = captured.filter((c) => c.body.subject.type !== 'SubAgent');
      const parentTraces = new Set(parentCalls.map((c) => traceIdOf(c.traceparent)));
      assert.equal(parentTraces.size, 1, 'prompt + spawns + agent management share the turn trace');
      const parentTrace = [...parentTraces][0];
      const manage = bodies.filter((b) => b.resource.id === 'read_agent' || b.resource.id === 'list_agents');
      assert.equal(manage.length, 2);
      for (const b of manage) {
        assert.equal(b.action.name, 'invokeTool');
        assert.equal(b.subject.type, 'Agent');
      }

      const childTraces = [CHILDREN[1], CHILDREN[3], GRANDCHILD].map((id) => traceOfSubject(`dev:${id}`));
      assert.equal(new Set([parentTrace, ...childTraces]).size, 4, 'parent + each subagent: distinct traces');

      // A subagent's spawn of its own child sits in that subagent's trace.
      const nestedSpawn = captured.find((c) => c.body.action.name === 'spawn' && c.body.subject.id === `dev:${CHILDREN[0]}`)!;
      assert.notEqual(traceIdOf(nestedSpawn.traceparent), parentTrace);

      // Pre and post of the same subagent tool call pair on one span.
      const childSpans = new Set(
        captured.filter((c) => c.body.subject.id === `dev:${CHILDREN[1]}`).map((c) => c.traceparent?.split('-')[2]),
      );
      assert.equal(childSpans.size, 1, 'pre/post share a span');

      // Spawns are counted per turn across the whole session, nested included.
      const spawns = bodies.filter((b) => b.action.name === 'spawn');
      assert.deepEqual(spawns.map((b) => b.context.subagentIndex), [1, 2, 3, 4, 5]);
      assert.equal(spawns[4].subject.type, 'SubAgent', 'a child spawning is itself a SubAgent');
      assert.equal(spawns[4].subject.id, `dev:${CHILDREN[0]}`);

      // Child 2's calls: SubAgent subject, User → Agent → spawn lineage.
      const childCalls = bodies.filter((b) => b.subject.id === `dev:${CHILDREN[1]}`);
      assert.equal(childCalls.length, 2, 'pre + post');
      for (const b of childCalls) {
        assert.equal(b.subject.type, 'SubAgent');
        assert.equal(b.subject.properties?.agentType, 'explore');
        assert.equal(b.action.name, 'executeBash');
        assert.deepEqual(b.context.hops.map((h: any) => h.action.name), ['invokeAgent', 'spawn']);
      }

      // FIFO binding: kickoffs claim spawn lineages in spawn order, so each
      // child's spawn hop is strictly later than the previous child's.
      const spawnTimes = CHILDREN.map((id) => Date.parse(resolveSubAgent(id, dataDir)!.lineage[1].time));
      for (let i = 1; i < spawnTimes.length; i++) assert.ok(spawnTimes[i] > spawnTimes[i - 1], `child ${i} bound out of order`);

      // Grandchild: three hops deep, last spawn made by the child SubAgent.
      const grand = bodies.find((b) => b.subject.id === `dev:${GRANDCHILD}`);
      assert.ok(grand, 'grandchild call evaluated');
      assert.equal(grand.action.name, 'read');
      assert.deepEqual(grand.context.hops.map((h: any) => h.action.name), ['invokeAgent', 'spawn', 'spawn']);
      assert.equal(grand.context.hops[2].subject.id, `dev:${CHILDREN[0]}`);

      // 7. sessionEnd for the parent clears every registration under it.
      assert.ok(resolveSubAgent(GRANDCHILD, dataDir));
      await runHook('sessionEnd.js', { sessionId: PARENT, cwd, reason: 'user_exit' }, env);
      for (const id of [...CHILDREN, GRANDCHILD]) assert.equal(resolveSubAgent(id, dataDir), undefined);
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
