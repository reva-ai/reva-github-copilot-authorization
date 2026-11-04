import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveCopilotMcpTool } from '../src/copilotMcp';

// tool.execution_start as Copilot CLI 1.0.105 writes it, before preToolUse runs.
const mcpStart = (toolName: string, server: string, tool: string, configName = server) => ({
  type: 'tool.execution_start',
  data: {
    toolCallId: 'toolu_1',
    toolName,
    arguments: {},
    mcpServerName: server,
    mcpConfigServerName: configName,
    mcpTransport: 'stdio',
    mcpConfigSource: 'user',
    mcpToolName: tool,
  },
});
const builtinStart = (toolName: string) => ({ type: 'tool.execution_start', data: { toolCallId: 'toolu_2', toolName, arguments: {} } });

interface Dirs {
  copilotHome: string;
  home: string;
  cwd: string;
}

// copilotHome holds session records; home/.copilot/mcp-config.json the configured servers.
function withDirs(
  setup: { sessions?: Record<string, object[]>; userServers?: Record<string, object> },
  fn: (dirs: Dirs) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-copilot-mcp-'));
  const dirs = { copilotHome: path.join(root, 'copilot'), home: path.join(root, 'home'), cwd: path.join(root, 'work') };
  try {
    fs.mkdirSync(path.join(dirs.home, '.copilot'), { recursive: true });
    fs.mkdirSync(dirs.cwd, { recursive: true });
    for (const [id, events] of Object.entries(setup.sessions || {})) {
      const dir = path.join(dirs.copilotHome, 'session-state', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }
    if (setup.userServers) {
      fs.writeFileSync(path.join(dirs.home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: setup.userServers }), 'utf8');
    }
    fn(dirs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const resolve = (dirs: Dirs, toolName: string, sessionIds: string[] = ['s1']) =>
  resolveCopilotMcpTool({ toolName, sessionIds, cwd: dirs.cwd, copilotHome: dirs.copilotHome, home: dirs.home });

test('reads the server from the session record (as in the live arxiv session)', () => {
  withDirs({ sessions: { s1: [mcpStart('arxiv-search_papers', 'arxiv', 'search_papers')] } }, (dirs) => {
    assert.deepEqual(resolve(dirs, 'arxiv-search_papers'), { server: 'arxiv', tool: 'search_papers' });
  });
});

test('a server name with "-" in it (the built-in github-mcp-server)', () => {
  withDirs(
    { sessions: { s1: [mcpStart('github-mcp-server-list_copilot_spaces', 'github-mcp-server', 'list_copilot_spaces')] } },
    (dirs) => {
      assert.deepEqual(resolve(dirs, 'github-mcp-server-list_copilot_spaces'), {
        server: 'github-mcp-server',
        tool: 'list_copilot_spaces',
      });
    },
  );
});

test('the configured name wins over the display name, so the id matches what discovery ingests', () => {
  withDirs({ sessions: { s1: [mcpStart('docs-search', 'Docs Server', 'search', 'docs')] } }, (dirs) => {
    assert.equal(resolve(dirs, 'docs-search')?.server, 'docs');
  });
});

test("a subagent's call is found in the root session's record", () => {
  withDirs({ sessions: { root: [mcpStart('arxiv-search_papers', 'arxiv', 'search_papers')] } }, (dirs) => {
    assert.equal(resolve(dirs, 'arxiv-search_papers', ['sub-1', 'root'])?.server, 'arxiv');
  });
});

test('no session record: the longest configured server name that prefixes the tool name', () => {
  withDirs({ userServers: { arxiv: { type: 'local', command: 'uvx' }, 'arxiv-extra': { type: 'local', command: 'uvx' } } }, (dirs) => {
    assert.deepEqual(resolve(dirs, 'arxiv-extra-search'), { server: 'arxiv-extra', tool: 'search' });
    assert.deepEqual(resolve(dirs, 'arxiv-search_papers'), { server: 'arxiv', tool: 'search_papers' });
  });
});

test('no session record: the built-in github-mcp-server is still recognized', () => {
  withDirs({}, (dirs) => {
    assert.deepEqual(resolve(dirs, 'github-mcp-server-get_me'), { server: 'github-mcp-server', tool: 'get_me' });
  });
});

test('a record showing a non-MCP call is not overridden by a config-name guess', () => {
  withDirs({ sessions: { s1: [builtinStart('arxiv-search_papers')] }, userServers: { arxiv: { command: 'uvx' } } }, (dirs) => {
    assert.equal(resolve(dirs, 'arxiv-search_papers'), undefined);
  });
});

test('unknown tools, a missing record and a broken record all resolve to nothing', () => {
  withDirs({ sessions: { s1: [] } }, (dirs) => {
    fs.appendFileSync(path.join(dirs.copilotHome, 'session-state', 's1', 'events.jsonl'), '{"type":"tool.execution_start", broken\n');
    assert.equal(resolve(dirs, 'read_powershell'), undefined);
    assert.equal(resolve(dirs, 'some-tool', ['missing']), undefined);
    assert.equal(resolve(dirs, 'some-tool', []), undefined);
  });
});
