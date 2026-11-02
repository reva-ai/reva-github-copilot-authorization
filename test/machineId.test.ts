import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { _resetDeviceIdCacheForTests, resolveMachineId } from '../src/deviceId';
import { ingestUser } from '../src/ingestionClient';
import { RevaConfig } from '../src/types';

const REAL = 'c0ffee00-1111-2222-3333-444455556666';

function withDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-machine-id-'));
  _resetDeviceIdCacheForTests();
  return Promise.resolve(fn(dir)).finally(() => {
    _resetDeviceIdCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('the OS machine id is used and saved for later hooks', () =>
  withDir((dir) => {
    let reads = 0;
    assert.equal(resolveMachineId(dir, () => (reads++, REAL)), REAL);
    assert.equal(fs.readFileSync(path.join(dir, 'machine-id'), 'utf8'), REAL);
    _resetDeviceIdCacheForTests();
    assert.equal(resolveMachineId(dir, () => (reads++, 'should-not-be-read')), REAL, 'a new hook reads the saved id');
    assert.equal(reads, 1);
  }));

test('no OS id means no machine id — never a random stand-in', () =>
  withDir((dir) => {
    assert.equal(resolveMachineId(dir, () => undefined), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'machine-id')), false);
    assert.equal(fs.existsSync(path.join(dir, 'device-id')), false);
  }));

test('an old random device-id file is ignored', () =>
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'device-id'), '624c2cfb-7152-45e5-9876-0d14e74c5b43');
    assert.equal(resolveMachineId(dir, () => undefined), undefined);
  }));

test('a value that is not a machine id is neither used nor saved', () =>
  withDir((dir) => {
    assert.equal(resolveMachineId(dir, () => 'ERROR: access denied'), undefined);
    fs.writeFileSync(path.join(dir, 'machine-id'), 'garbage');
    _resetDeviceIdCacheForTests();
    assert.equal(resolveMachineId(dir, () => REAL), REAL, 'a bad saved value is replaced by a real read');
  }));

test('a Linux 32-hex machine-id is accepted', () =>
  withDir((dir) => {
    assert.equal(resolveMachineId(dir, () => '0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  }));

// ---- User registration --------------------------------------------------------

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
  body: any;
}

async function withFetch(status: (method: string) => number, fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, opts: any) => {
    const method = opts?.method || 'GET';
    calls.push({ method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return new Response('{}', { status: status(method), headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('a new User without a machine id is created without registeredMachineIds', () =>
  withDir(() =>
    withFetch(
      (m) => (m === 'GET' ? 404 : 200),
      async (calls) => {
        await ingestUser(cfg, 'user-type', 'dev@example.com', undefined, 'agent-1');
        const post = calls.find((c) => c.method === 'POST');
        assert.ok(post);
        assert.equal(post!.body.attributes.some((a: any) => a.name === 'registeredMachineIds'), false);
        assert.ok(post!.body.attributes.some((a: any) => a.name === 'agents'));
      },
    ),
  ));

test('an existing User is not PATCHed with a machine id when there is none', () =>
  withDir(() =>
    withFetch(
      () => 200,
      async (calls) => {
        await ingestUser(cfg, 'user-type', 'dev@example.com', undefined, 'agent-1');
        const names = calls.filter((c) => c.method === 'PATCH').map((c) => c.body?.attributeValue?.name);
        assert.deepEqual(names, ['agents']);
      },
    ),
  ));

test('a real machine id is registered', () =>
  withDir(() =>
    withFetch(
      () => 200,
      async (calls) => {
        await ingestUser(cfg, 'user-type', 'dev@example.com', REAL, 'agent-1');
        const values = calls
          .filter((c) => c.method === 'PATCH' && c.body?.attributeValue?.name === 'registeredMachineIds')
          .map((c) => c.body.attributeValue.value);
        assert.deepEqual(values, [REAL]);
      },
    ),
  ));
