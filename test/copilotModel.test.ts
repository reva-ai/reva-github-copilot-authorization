import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveCopilotModel } from '../src/copilotModel';
import { osFamily } from '../src/deviceId';
import { ingestAgent, recordAgentModel } from '../src/ingestionClient';
import { RevaConfig } from '../src/types';

// Event shapes captured from Copilot CLI 1.0.103 session-state/<id>/events.jsonl.
const ev = {
  modelChange: (newModel: string) => ({ type: 'session.model_change', data: { cause: 'initial_resolution', newModel } }),
  autoResolved: (chosenModel: string) => ({ type: 'session.auto_mode_resolved', data: { chosenModel, routingMethod: 'auto_v2' } }),
  subagent: (agentId: string, model: string) => ({ type: 'subagent.configured', agentId, data: { model, reasoningEffort: 'low' } }),
  // A title-generation helper call — must never be mistaken for the session model.
  helperTurn: () => ({ type: 'model.turn_started', data: { model: 'gpt-4o-mini' } }),
};

function withSession(sessionId: string, events: object[], fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-copilot-home-'));
  try {
    const dir = path.join(home, 'session-state', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Auto: the model Auto chose (as on the Mac session: auto → gpt-6-luna)', () => {
  withSession('s1', [ev.modelChange('auto'), ev.helperTurn(), ev.autoResolved('gpt-6-luna')], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 's1', copilotHome: home }), 'gpt-6-luna');
  });
});

test('an explicitly selected model', () => {
  withSession('s2', [ev.modelChange('claude-sonnet-5.5'), ev.helperTurn()], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 's2', copilotHome: home }), 'claude-sonnet-5.5');
  });
});

test('the most recent change wins (a /model switch mid-session)', () => {
  withSession('s3', [ev.modelChange('auto'), ev.autoResolved('gpt-6-luna'), ev.modelChange('claude-sonnet-5.5')], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 's3', copilotHome: home }), 'claude-sonnet-5.5');
  });
});

test('Auto not yet resolved is unknown, never "auto" and never a helper model', () => {
  withSession('s4', [ev.modelChange('auto'), ev.helperTurn()], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 's4', copilotHome: home }), undefined);
  });
});

test("a subagent's own model comes from subagent.configured; otherwise it inherits the session's", () => {
  withSession('root', [ev.modelChange('claude-sonnet-5.5'), ev.subagent('child-1', 'gpt-5.6-luna')], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 'root', subAgentId: 'child-1', copilotHome: home }), 'gpt-5.6-luna');
    assert.equal(resolveCopilotModel({ sessionId: 'root', subAgentId: 'child-2', copilotHome: home }), 'claude-sonnet-5.5');
  });
});

test('VS Code Copilot Chat: the model from session.start selectedModel', () => {
  const start = { type: 'session.start', data: { sessionId: 'v1', selectedModel: 'claude-opus-5.5' } };
  const vscodeHelper = { type: 'assistant.message', data: { model: 'gpt-5.4-nano' } };
  withSession('v1', [start, vscodeHelper, ev.helperTurn()], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 'v1', copilotHome: home }), 'claude-opus-5.5');
  });
});

test('a later model change wins over session.start selectedModel', () => {
  const start = { type: 'session.start', data: { sessionId: 'v2', selectedModel: 'claude-opus-5.5' } };
  withSession('v2', [start, ev.modelChange('gpt-6-luna')], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 'v2', copilotHome: home }), 'gpt-6-luna');
  });
  withSession('v3', [{ type: 'session.start', data: { selectedModel: 'auto' } }], (home) => {
    assert.equal(resolveCopilotModel({ sessionId: 'v3', copilotHome: home }), undefined);
  });
});

test('no session record resolves to undefined', () => {
  assert.equal(resolveCopilotModel({ sessionId: 'missing', copilotHome: os.tmpdir() }), undefined);
});

test('osFamily: windows / macos / linux, anything else passes through', () => {
  assert.equal(osFamily('win32'), 'windows');
  assert.equal(osFamily('darwin'), 'macos');
  assert.equal(osFamily('linux'), 'linux');
  assert.equal(osFamily('freebsd'), 'freebsd');
});

// ---- Agent entity attributes -------------------------------------------------

const cfg: RevaConfig = {
  rtgUrl: 'https://pdp.test/evaluate',
  authorization: 't',
  agentId: 'agent-1',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

interface Call {
  method: string;
  url: string;
  body: any;
}

async function withFetch(respond: (c: Call) => { status: number; json?: any }, fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const call = { method: opts?.method || 'GET', url: String(url), body: opts?.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const { status, json } = respond(call);
    return new Response(JSON.stringify(json ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-agent-attrs-'));
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({ userEntityTypeId: 'user-type', agentEntityTypeId: 'agent-type', mcpServerEntityTypeId: 'mcp-type' }),
  );
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const patchedValues = (calls: Call[], name: string) =>
  calls.filter((c) => c.method === 'PATCH' && c.body?.attributeValue?.name === name).map((c) => c.body.attributeValue.value);

test('a new Agent is created with its real OS family in operatingSystems', async () => {
  await withDataDir(async (dir) => {
    await withFetch(
      (c) => (c.method === 'GET' ? { status: 404 } : { status: 200 }),
      async (calls) => {
        await ingestAgent(cfg, 'agent-type', 'agent-1', 'dev@example.com', dir);
        const post = calls.find((c) => c.method === 'POST');
        assert.ok(post, 'POST sent');
        assert.deepEqual(
          post!.body.attributes.find((a: any) => a.name === 'operatingSystems'),
          { name: 'operatingSystems', value: osFamily() },
        );
      },
    );
  });
});

test('an existing Agent gets operatingSystems PATCH-ADDed on its own call', async () => {
  await withDataDir(async (dir) => {
    await withFetch(
      (c) => (c.method === 'GET' ? { status: 200, json: { id: 'agent-1', entityAttributes: [] } } : { status: 200 }),
      async (calls) => {
        await ingestAgent(cfg, 'agent-type', 'agent-1', 'dev@example.com', dir);
        assert.deepEqual(patchedValues(calls, 'operatingSystems'), [osFamily()]);
        assert.deepEqual(patchedValues(calls, 'agentType'), ['GitHubCopilot']);
      },
    );
  });
});

test('recordAgentModel PATCH-ADDs a new model once, then skips it', async () => {
  await withDataDir(async (dir) => {
    await withFetch(
      () => ({ status: 200 }),
      async (calls) => {
        await recordAgentModel(cfg, 'agent-1', 'gpt-6-luna', dir);
        await recordAgentModel(cfg, 'agent-1', 'gpt-6-luna', dir);
        await recordAgentModel(cfg, 'agent-1', 'claude-sonnet-5.5', dir);
        assert.deepEqual(patchedValues(calls, 'models'), ['gpt-6-luna', 'claude-sonnet-5.5']);
      },
    );
  });
});

test('a failed models PATCH is retried on the next prompt, and never throws', async () => {
  await withDataDir(async (dir) => {
    await withFetch(
      () => ({ status: 500 }),
      async () => {
        await recordAgentModel(cfg, 'agent-1', 'gpt-6-luna', dir);
      },
    );
    await withFetch(
      () => ({ status: 200 }),
      async (calls) => {
        await recordAgentModel(cfg, 'agent-1', 'gpt-6-luna', dir);
        assert.deepEqual(patchedValues(calls, 'models'), ['gpt-6-luna']);
      },
    );
  });
});

test('no model, no call', async () => {
  await withDataDir(async (dir) => {
    await withFetch(
      () => ({ status: 200 }),
      async (calls) => {
        await recordAgentModel(cfg, 'agent-1', undefined, dir);
        assert.equal(calls.length, 0);
      },
    );
  });
});
