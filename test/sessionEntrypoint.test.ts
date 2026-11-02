import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getSessionEntry, markSessionActive } from '../src/activeSessions';
import {
  CLI_ENTRYPOINT,
  DESKTOP_ENTRYPOINT,
  DESKTOP_INTEGRATION_ID,
  IDE_ENTRYPOINT,
  IDE_ENTRYPOINT_PREFIX,
  editorFromProcessName,
  findEditorInProcessTree,
  resolveEditor,
  resolveSessionEntrypoint,
  resolveSessionEntrypointForSession,
} from '../src/identity';

// VS Code 1.143.1 integrated terminal on Windows.
const VSCODE_WINDOWS_TERMINAL = {
  TERM_PROGRAM: 'vscode',
  VSCODE_GIT_ASKPASS_MAIN:
    'c:\\Users\\x\\AppData\\Roaming\\Code\\User\\globalStorage\\vscode.git\\askpass\\abc\\askpass-main.js',
  VSCODE_GIT_ASKPASS_NODE: 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
  VSCODE_GIT_IPC_HANDLE: '\\\\.\\pipe\\vscode-git-abc-sock',
};

describe('resolveSessionEntrypoint', () => {
  it('exports the exact policy-visible strings', () => {
    assert.equal(CLI_ENTRYPOINT, 'cli');
    assert.equal(IDE_ENTRYPOINT, 'ide');
    assert.equal(IDE_ENTRYPOINT_PREFIX, 'ide-');
  });

  it('defaults to cli when nothing is detected or declared', () => {
    assert.equal(resolveSessionEntrypoint({}), 'cli');
  });

  it('reports ide-vscode for the real VS Code terminal values', () => {
    assert.equal(resolveSessionEntrypoint(VSCODE_WINDOWS_TERMINAL), 'ide-vscode');
  });

  it('reports ide-vscode from the extension host cache path', () => {
    assert.equal(
      resolveSessionEntrypoint({ VSCODE_CODE_CACHE_PATH: 'C:\\Users\\x\\AppData\\Roaming\\Code\\CachedData\\0123abcd' }),
      'ide-vscode',
    );
  });

  it('reports ide-vscode from VSCODE_GIT_IPC_HANDLE alone (tmux overwrote TERM_PROGRAM) with an askpass path', () => {
    assert.equal(
      resolveSessionEntrypoint({
        TERM_PROGRAM: 'tmux',
        VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git-abc.sock',
        VSCODE_GIT_ASKPASS_MAIN: '/home/x/.config/Code/User/globalStorage/vscode.git/askpass-main.js',
      }),
      'ide-vscode',
    );
  });

  it('names Cursor, Windsurf and Code - Insiders from their folders on Windows, macOS and Linux', () => {
    const cases: [string, string][] = [
      ['C:\\Users\\x\\AppData\\Roaming\\Cursor\\User\\globalStorage\\vscode.git\\askpass-main.js', 'ide-cursor'],
      ['/Users/x/Library/Application Support/Cursor/User/globalStorage/vscode.git/askpass-main.js', 'ide-cursor'],
      ['/home/x/.config/Cursor/User/globalStorage/vscode.git/askpass-main.js', 'ide-cursor'],
      ['C:\\Users\\x\\AppData\\Roaming\\Windsurf\\User\\globalStorage\\vscode.git\\askpass-main.js', 'ide-windsurf'],
      ['/Users/x/Library/Application Support/Windsurf/User/globalStorage/vscode.git/askpass-main.js', 'ide-windsurf'],
      ['/home/x/.config/Windsurf/User/globalStorage/vscode.git/askpass-main.js', 'ide-windsurf'],
      ['C:\\Users\\x\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\vscode.git\\askpass-main.js', 'ide-vscode-insiders'],
      ['/Users/x/Library/Application Support/Code - Insiders/User/globalStorage/vscode.git/askpass-main.js', 'ide-vscode-insiders'],
      ['/home/x/.config/Code - Insiders/User/globalStorage/vscode.git/askpass-main.js', 'ide-vscode-insiders'],
      ['/home/x/.config/Some Editor/User/globalStorage/vscode.git/askpass-main.js', 'ide-some-editor'],
    ];
    for (const [askpass, expected] of cases) {
      assert.equal(
        resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: askpass }),
        expected,
        askpass,
      );
    }
    assert.equal(
      resolveSessionEntrypoint({ VSCODE_CODE_CACHE_PATH: '/Users/x/Library/Application Support/Cursor/CachedData/abc' }),
      'ide-cursor',
    );
  });

  it('falls back to the executable name', () => {
    const cases: [string, string][] = [
      ['C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'ide-vscode'],
      ['C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'ide-cursor'],
      [
        '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
        'ide-vscode',
      ],
      ['/usr/share/code-insiders/code-insiders', 'ide-vscode-insiders'],
    ];
    for (const [node, expected] of cases) {
      assert.equal(resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: node }), expected, node);
    }
  });

  it('reports ide, not a default editor, when nothing names the editor', () => {
    const env = { TERM_PROGRAM: 'vscode' };
    assert.equal(resolveSessionEntrypoint(env), 'ide');
    assert.equal(resolveEditor(env), undefined);
    assert.equal(resolveSessionEntrypoint({ VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git.sock' }), 'ide');
  });

  it('a stray VSCODE_GIT_ASKPASS_NODE without an editor marker stays cli', () => {
    assert.equal(
      resolveSessionEntrypoint({ VSCODE_GIT_ASKPASS_NODE: 'C:\\Programs\\Microsoft VS Code\\Code.exe' }),
      'cli',
    );
  });

  it('other terminals are cli', () => {
    for (const term of ['Apple_Terminal', 'iTerm.app', 'tmux', 'WezTerm', '']) {
      assert.equal(resolveSessionEntrypoint({ TERM_PROGRAM: term }), 'cli', term);
    }
    assert.equal(resolveSessionEntrypoint({ TERM_PROGRAM: 'Apple_Terminal', VSCODE_GIT_IPC_HANDLE: '  ' }), 'cli');
  });

  it('reports Copilot Desktop for the desktop app’s integration id', () => {
    assert.equal(DESKTOP_ENTRYPOINT, 'Copilot Desktop');
    assert.equal(DESKTOP_INTEGRATION_ID, 'copilot-developer-app');
    assert.equal(resolveSessionEntrypoint({ GITHUB_COPILOT_INTEGRATION_ID: 'copilot-developer-app' }), 'Copilot Desktop');
    assert.equal(resolveSessionEntrypoint({ GITHUB_COPILOT_INTEGRATION_ID: ' Copilot-Developer-App ' }), 'Copilot Desktop');
  });

  it('reports Copilot Desktop from the desktop client metadata URL that reaches hooks', () => {
    assert.equal(
      resolveSessionEntrypoint({ COPILOT_MCP_CIMD_CLIENT_ID_URL: 'https://github.com/copilot/desktop/client-metadata.json' }),
      'Copilot Desktop',
    );
    assert.equal(
      resolveSessionEntrypoint({ COPILOT_MCP_CIMD_CLIENT_ID_URL: 'https://github.com/copilot/cli/client-metadata.json' }),
      'cli',
    );
    assert.equal(resolveSessionEntrypoint({ COPILOT_MCP_CIMD_CLIENT_ID_URL: '' }), 'cli');
  });

  it('the desktop app wins over editor markers and REVA_SESSION_ENTRYPOINT', () => {
    assert.equal(
      resolveSessionEntrypoint({
        ...VSCODE_WINDOWS_TERMINAL,
        GITHUB_COPILOT_INTEGRATION_ID: 'copilot-developer-app',
        REVA_SESSION_ENTRYPOINT: 'cli',
      }),
      'Copilot Desktop',
    );
  });

  it('other integration ids are not mapped and fall through', () => {
    assert.equal(resolveSessionEntrypoint({ GITHUB_COPILOT_INTEGRATION_ID: 'vscode-chat' }), 'cli');
    assert.equal(resolveSessionEntrypoint({ GITHUB_COPILOT_INTEGRATION_ID: 'copilot-developer-cli' }), 'cli');
    assert.equal(
      resolveSessionEntrypoint({ ...VSCODE_WINDOWS_TERMINAL, GITHUB_COPILOT_INTEGRATION_ID: 'something-else' }),
      'ide-vscode',
    );
  });

  it('uses REVA_SESSION_ENTRYPOINT only outside an editor', () => {
    assert.equal(resolveSessionEntrypoint({ REVA_SESSION_ENTRYPOINT: ' copilot-ci ' }), 'copilot-ci');
    assert.equal(
      resolveSessionEntrypoint({ ...VSCODE_WINDOWS_TERMINAL, REVA_SESSION_ENTRYPOINT: 'cli' }),
      'ide-vscode',
    );
  });
});

// ---- VS Code Copilot Chat: editor from the hook's parent processes ----------

// Process chains on Windows (nearest parent first).
const VSCODE_CHAT_CHAIN = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\2c33b50b16\\resources\\app\\node_modules.asar.unpacked\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe',
  'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
  'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
];
const DESKTOP_APP_CHAIN = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Users\\x\\AppData\\Local\\github-copilot-sdk\\cli\\copilot-sdk-runtime-1.0.102\\copilot-runtime.exe',
  'C:\\Users\\x\\AppData\\Local\\Programs\\GitHub Copilot\\github.exe',
  'C:\\Windows\\explorer.exe',
];
const TERMINAL_CLI_CHAIN = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\node_modules\\@github\\copilot-win32-x64\\copilot.exe',
  'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe',
  'C:\\Windows\\explorer.exe',
];

function withDataDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-entrypoint-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('editor from parent processes', () => {
  it('recognises only known editor executables', () => {
    assert.equal(editorFromProcessName('C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'), 'vscode');
    assert.equal(editorFromProcessName('C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe'), 'vscode-insiders');
    assert.equal(editorFromProcessName('C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe'), 'cursor');
    assert.equal(editorFromProcessName('Windsurf.exe'), 'windsurf');
    assert.equal(
      editorFromProcessName('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'),
      'vscode',
    );
    assert.equal(editorFromProcessName('/Applications/Cursor.app/Contents/MacOS/Cursor'), 'cursor');
    assert.equal(editorFromProcessName('/usr/share/code-insiders/code-insiders'), 'vscode-insiders');
    assert.equal(editorFromProcessName('code'), 'vscode');
    for (const other of ['powershell.exe', 'copilot-runtime.exe', 'github.exe', 'node', 'WindowsTerminal.exe', 'explorer.exe', '']) {
      assert.equal(editorFromProcessName(other), undefined, other);
    }
  });

  it('finds the nearest editor in the chain', () => {
    assert.equal(findEditorInProcessTree(() => VSCODE_CHAT_CHAIN), 'vscode');
    assert.equal(findEditorInProcessTree(() => DESKTOP_APP_CHAIN), undefined);
    assert.equal(findEditorInProcessTree(() => TERMINAL_CLI_CHAIN), undefined);
    assert.equal(findEditorInProcessTree(() => []), undefined, 'a failed lookup finds nothing');
  });
});

describe('resolveSessionEntrypointForSession', () => {
  it('VS Code Copilot Chat → ide-vscode, looked up once per session', () =>
    withDataDir((dir) => {
      let walks = 0;
      const findEditor = () => (walks++, findEditorInProcessTree(() => VSCODE_CHAT_CHAIN));
      const opts = { agentId: 'a', sessionId: 's1', pluginDataDir: dir, env: {}, findEditor };
      assert.equal(resolveSessionEntrypointForSession(opts), 'ide-vscode');
      markSessionActive('a', 's1', 'ide-vscode', dir);
      assert.equal(resolveSessionEntrypointForSession(opts), 'ide-vscode');
      assert.equal(walks, 1, 'the saved answer is reused');
      assert.equal(getSessionEntry('a', 's1', dir)?.editorFromProcess, 'vscode', 'a refresh keeps it');
    }));

  it('no editor in the chain → cli, and the empty answer is saved too', () =>
    withDataDir((dir) => {
      let walks = 0;
      const opts = { agentId: 'a', sessionId: 's2', pluginDataDir: dir, env: {}, findEditor: () => (walks++, undefined) };
      assert.equal(resolveSessionEntrypointForSession(opts), 'cli');
      assert.equal(resolveSessionEntrypointForSession(opts), 'cli');
      assert.equal(walks, 1);
    }));

  it('the environment wins without any process lookup', () =>
    withDataDir((dir) => {
      const findEditor = () => assert.fail('no walk expected');
      assert.equal(
        resolveSessionEntrypointForSession({
          agentId: 'a', sessionId: 's3', pluginDataDir: dir, findEditor,
          env: { COPILOT_MCP_CIMD_CLIENT_ID_URL: 'https://github.com/copilot/desktop/client-metadata.json' },
        }),
        'Copilot Desktop',
      );
      assert.equal(
        resolveSessionEntrypointForSession({ agentId: 'a', sessionId: 's3', pluginDataDir: dir, findEditor, env: VSCODE_WINDOWS_TERMINAL }),
        'ide-vscode',
      );
    }));

  it('sessionStart (allowProcessLookup: false) does not walk; the next hook does', () =>
    withDataDir((dir) => {
      let walks = 0;
      const findEditor = () => (walks++, 'vscode');
      const base = { agentId: 'a', sessionId: 's4', pluginDataDir: dir, env: {}, findEditor };
      assert.equal(resolveSessionEntrypointForSession({ ...base, allowProcessLookup: false }), 'cli');
      assert.equal(walks, 0);
      assert.equal(resolveSessionEntrypointForSession(base), 'ide-vscode');
      assert.equal(walks, 1);
    }));

  it('an editor process wins over REVA_SESSION_ENTRYPOINT, which still applies when there is none', () =>
    withDataDir((dir) => {
      const env = { REVA_SESSION_ENTRYPOINT: 'my-surface' };
      assert.equal(
        resolveSessionEntrypointForSession({ agentId: 'a', sessionId: 's5', pluginDataDir: dir, env, findEditor: () => 'cursor' }),
        'ide-cursor',
      );
      assert.equal(
        resolveSessionEntrypointForSession({ agentId: 'a', sessionId: 's6', pluginDataDir: dir, env, findEditor: () => undefined }),
        'my-surface',
      );
    }));

  it('without a data folder the process is never walked', () => {
    const findEditor = () => assert.fail('no walk expected');
    assert.equal(resolveSessionEntrypointForSession({ agentId: 'a', sessionId: 's7', env: {}, findEditor }), 'cli');
  });
});
