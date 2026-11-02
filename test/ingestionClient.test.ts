import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ingestDiscoveredMcpServers,
  resolveEntityTypeIds,
} from '../src/ingestionClient';
import { DiscoveredMcpServer } from '../src/mcpDiscovery';
import { RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  rtgUrl: 'https://pdp.test/evaluate',
  authorization: 'eval-token',
  agentId: 'aa-bb-cc-dd-ee-ff',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-ingest-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function methodOf(opts: any): string {
  return opts?.method || 'GET';
}

function discoverOf(entries: DiscoveredMcpServer[]): (cwd: string) => DiscoveredMcpServer[] {
  return () => entries;
}

const entityTypesResponse = [
  { id: 'user-type-id', name: 'User', schemaName: 'CodingAgent' },
  { id: 'agent-type-id', name: 'Agent', schemaName: 'CodingAgent' },
  { id: 'mcp-type-id', name: 'MCPServer', schemaName: 'CodingAgent' },
];

test('resolveEntityTypeIds(forceRefresh=true) re-fetches and replaces the cache even when it was already complete', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'old-user-id',
        agentEntityTypeId: 'old-agent-id',
        mcpServerEntityTypeId: 'old-mcp-id',
      }),
      'utf8',
    );

    let fetchCount = 0;
    const result = await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    assert.equal(fetchCount, 1);
    assert.equal(result.userEntityTypeId, 'user-type-id');
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'user-type-id');
  });
});

test('resolveEntityTypeIds(forceRefresh=true) falls back to the old cache if the forced fetch itself fails', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'old-user-id',
        agentEntityTypeId: 'old-agent-id',
        mcpServerEntityTypeId: 'old-mcp-id',
      }),
      'utf8',
    );

    const result = await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    assert.equal(result.userEntityTypeId, 'old-user-id');
  });
});

test('a changed entity-type id clears knownMcpServerNames — a migration must not leave servers stuck "already ingested"', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'OLD-user',
        agentEntityTypeId: 'OLD-agent',
        mcpServerEntityTypeId: 'OLD-mcp',
        knownMcpServerNames: ['gmail', 'google-calendar', 'miro'],
        lastMcpDiscoveryTriggeredAt: 1234,
        lastMcpInvokeIngestAt: 5678,
      }),
      'utf8',
    );

    await withFetch(
      (async () =>
        new Response(
          JSON.stringify([
            { id: 'NEW-user', name: 'User' },
            { id: 'NEW-agent', name: 'Agent' },
            { id: 'NEW-mcp', name: 'MCPServer' },
          ]),
          { status: 200 },
        )) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'NEW-user');
    assert.equal(cache.knownMcpServerNames, undefined);
    assert.equal(cache.lastMcpDiscoveryTriggeredAt, undefined);
    assert.equal(cache.lastMcpInvokeIngestAt, undefined);
  });
});

test('an UNCHANGED entity-type id leaves knownMcpServerNames intact — no needless re-ingestion', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'user-type-id',
        agentEntityTypeId: 'agent-type-id',
        mcpServerEntityTypeId: 'mcp-type-id',
        knownMcpServerNames: ['gmail'],
      }),
      'utf8',
    );

    await withFetch(
      (async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['gmail']);
  });
});

test('ingestDiscoveredMcpServers PATCHes registeredMcpServers onto the User for every new remote server', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        calls.push({ method: methodOf(opts), url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          'user-type-id',
          'alice@example.com',
          discoverOf([{ name: 'remote-server', url: 'https://example.com/mcp' }]),
        ),
    );

    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.ok(!patches[0].url.includes('/entity/bulk'));
    assert.deepEqual(patches[0].body, {
      attributeValue: { name: 'registeredMcpServers', value: 'remote-server' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.includes('/entity/bulk'));
    assert.equal(posts[0].body[0].entityId, 'remote-server');
  });
});

test('ingestDiscoveredMcpServers PATCHes registeredMcpServers for a local/stdio server too, even though it gets no MCPServer entity', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; body?: any }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        calls.push({ method: methodOf(opts), body: opts?.body ? JSON.parse(opts.body) : undefined });
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          'user-type-id',
          'alice@example.com',
          discoverOf([{ name: 'my-local-server' }]),
        ),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, {
      attributeValue: { name: 'registeredMcpServers', value: 'my-local-server' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
  });
});

test('ingestDiscoveredMcpServers without userEntityTypeId/userEmail never attempts registeredMcpServers', async () => {
  await withTempDir(async (dir) => {
    const patchCalls: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'PATCH') patchCalls.push(opts);
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          undefined,
          undefined,
          discoverOf([{ name: 'remote-server', url: 'https://example.com/mcp' }]),
        ),
    );

    assert.equal(patchCalls.length, 0);
  });
});

test('ingestDiscoveredMcpServers still ingests the MCPServer entity even if the registeredMcpServers PATCH fails', async () => {
  await withTempDir(async (dir) => {
    const posts: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'PATCH') return new Response('server error', { status: 500 });
        posts.push(...JSON.parse(opts.body));
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          'user-type-id',
          'alice@example.com',
          discoverOf([{ name: 'remote-server', url: 'https://example.com/mcp' }]),
        ),
    );

    assert.equal(posts.length, 1);
    assert.equal(posts[0].entityId, 'remote-server');
    // Name is NOT marked known when its registeredMcpServers PATCH failed.
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, [], 'a failed PATCH must leave the name retryable');
  });
});

test('ingestDiscoveredMcpServers does NOT mark a stdio entry known when the registeredMcpServers PATCH failed', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          'user-type-id',
          'alice@example.com',
          discoverOf([{ name: 'my-local-server' }]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, []);
  });
});

test('ingestDiscoveredMcpServers marks a stdio entry known when no User PATCH was attempted', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response(undefined, { status: 200 })) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          '/tmp',
          dir,
          undefined,
          undefined,
          discoverOf([{ name: 'my-local-server' }]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['my-local-server']);
  });
});
