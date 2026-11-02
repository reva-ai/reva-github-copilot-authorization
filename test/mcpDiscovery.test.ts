import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { discoverMcpServers } from '../src/mcpDiscovery';

function withDirs(fn: (cwd: string, home: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-home-'));
  try {
    fn(cwd, home);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

// Exactly what `copilot mcp add context7 -- npx -y @upstash/context7-mcp`
// wrote to ~/.copilot/mcp-config.json on CLI 1.0.97.
const USER_CONFIG = {
  mcpServers: {
    context7: { tools: ['*'], type: 'local', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  },
};

test('with nothing configured, only the built-in github-mcp-server is found', () => {
  withDirs((cwd, home) => {
    assert.deepEqual(discoverMcpServers(cwd, home), [{ name: 'github-mcp-server', displayName: 'github-mcp-server' }]);
  });
});

test('servers added with `copilot mcp add` (~/.copilot/mcp-config.json) are discovered', () => {
  withDirs((cwd, home) => {
    writeJson(path.join(home, '.copilot', 'mcp-config.json'), USER_CONFIG);
    const names = discoverMcpServers(cwd, home).map((s) => s.name);
    assert.deepEqual(names, ['context7', 'github-mcp-server']);
  });
});

test('a remote user server keeps its url; a local one has none', () => {
  withDirs((cwd, home) => {
    writeJson(path.join(home, '.copilot', 'mcp-config.json'), {
      mcpServers: { ...USER_CONFIG.mcpServers, docs: { type: 'http', url: 'https://example.com/mcp' } },
    });
    const byName = Object.fromEntries(discoverMcpServers(cwd, home).map((s) => [s.name, s]));
    assert.equal(byName.docs.url, 'https://example.com/mcp');
    assert.equal(byName.context7.url, undefined);
  });
});

test('a workspace definition wins over the user one with the same name', () => {
  withDirs((cwd, home) => {
    writeJson(path.join(home, '.copilot', 'mcp-config.json'), { mcpServers: { docs: { url: 'https://user.example/mcp' } } });
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { docs: { url: 'https://workspace.example/mcp' } } });
    const docs = discoverMcpServers(cwd, home).filter((s) => s.name === 'docs');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].url, 'https://workspace.example/mcp');
  });
});

test('servers in settings.json disabledMcpServers are skipped, built-in included', () => {
  withDirs((cwd, home) => {
    writeJson(path.join(home, '.copilot', 'mcp-config.json'), USER_CONFIG);
    // JSONC, as Copilot allows in settings.json.
    writeJson(
      path.join(home, '.copilot', 'settings.json'),
      '{\n  // turned off with `copilot mcp disable`\n  "disabledMcpServers": ["context7", "github-mcp-server"]\n}',
    );
    assert.deepEqual(discoverMcpServers(cwd, home), []);
  });
});

test('a malformed user config contributes nothing rather than throwing', () => {
  withDirs((cwd, home) => {
    writeJson(path.join(home, '.copilot', 'mcp-config.json'), '{ not json');
    assert.deepEqual(
      discoverMcpServers(cwd, home).map((s) => s.name),
      ['github-mcp-server'],
    );
  });
});
