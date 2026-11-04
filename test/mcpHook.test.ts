import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// Real compiled PreToolUse/PostToolUse entrypoints, real subprocesses, a
// stand-in Reva, and a Copilot home holding the session record Copilot
// writes for an MCP call (arxiv-search_papers, as in a live CLI session).
const AUTHORIZE = path.join(__dirname, '..', 'src', 'authorize.js');
const AUTHORIZE_POST = path.join(__dirname, '..', 'src', 'authorizePost.js');
const SESSION = 'mcp-session-1';

async function withReva(fn: (host: string, evaluations: any[]) => Promise<void>): Promise<void> {
  const evaluations: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.includes('/ai/evaluation')) {
        evaluations.push(JSON.parse(data));
        return res.end(JSON.stringify({ decision: true }));
      }
      res.end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`127.0.0.1:${(server.address() as AddressInfo).port}`, evaluations);
  } finally {
    server.close();
  }
}

interface Dirs {
  data: string;
  home: string;
  copilotHome: string;
}

async function withDirs(events: object[], fn: (dirs: Dirs) => Promise<void>): Promise<void> {
  const dirs = {
    data: fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-data-')),
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-home-')),
    copilotHome: fs.mkdtempSync(path.join(os.tmpdir(), 'reva-mcp-copilot-')),
  };
  const sessionDir = path.join(dirs.copilotHome, 'session-state', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    await fn(dirs);
  } finally {
    for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true });
  }
}

function run(script: string, payload: object, host: string, dirs: Dirs): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
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
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const ARXIV_START = {
  type: 'tool.execution_start',
  data: {
    toolCallId: 'toolu_1',
    toolName: 'arxiv-search_papers',
    arguments: { query: 'JevAI' },
    mcpServerName: 'arxiv',
    mcpConfigServerName: 'arxiv',
    mcpTransport: 'stdio',
    mcpConfigSource: 'user',
    mcpToolName: 'search_papers',
  },
};

const call = (dirs: Dirs) => ({
  sessionId: SESSION,
  timestamp: 1,
  cwd: dirs.data,
  toolName: 'arxiv-search_papers',
  toolArgs: { query: 'JevAI' },
});

test('an MCP call is sent as Tool "<server>/<tool>" under its MCPServer, pre and post alike', async () => {
  await withDirs([ARXIV_START], async (dirs) => {
    await withReva(async (host, evaluations) => {
      const pre = await run(AUTHORIZE, call(dirs), host, dirs);
      const post = await run(AUTHORIZE_POST, { ...call(dirs), toolResult: { resultType: 'success', textResultForLlm: 'ok' } }, host, dirs);
      assert.equal(pre.status, 0);
      assert.equal(post.status, 0);
      assert.equal(evaluations.length, 2);
      for (const body of evaluations) {
        assert.equal(body.action.name, 'invokeTool');
        assert.equal(body.resource.type, 'Tool');
        assert.equal(body.resource.id, 'arxiv/search_papers');
        assert.deepEqual(body.resource.parents, [{ type: 'MCPServer', id: 'arxiv' }]);
        assert.equal(body.resource.properties.connectionType, 'mcp');
      }
    });
  });
});

test('a built-in tool is not taken for an MCP call', async () => {
  await withDirs([], async (dirs) => {
    await withReva(async (host, evaluations) => {
      await run(AUTHORIZE, { ...call(dirs), toolName: 'read_powershell', toolArgs: { shellId: '1' } }, host, dirs);
      assert.equal(evaluations[0].resource.id, 'read_powershell');
      assert.equal(evaluations[0].resource.parents, undefined);
    });
  });
});
