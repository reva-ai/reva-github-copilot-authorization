"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDE_ENTRYPOINT_PREFIX = exports.IDE_ENTRYPOINT = exports.CLI_ENTRYPOINT = exports.DESKTOP_INTEGRATION_ID = exports.DESKTOP_ENTRYPOINT = void 0;
exports.resolveUserEmail = resolveUserEmail;
exports.resolveEditor = resolveEditor;
exports.resolveSessionEntrypoint = resolveSessionEntrypoint;
exports.editorFromProcessName = editorFromProcessName;
exports.listAncestorProcesses = listAncestorProcesses;
exports.findEditorInProcessTree = findEditorInProcessTree;
exports.resolveSessionEntrypointForSession = resolveSessionEntrypointForSession;
exports.resolveAgentContext = resolveAgentContext;
exports.resolveCaller = resolveCaller;
const node_child_process_1 = require("node:child_process");
const os = __importStar(require("node:os"));
const activeSessions_1 = require("./activeSessions");
const copilotAccount_1 = require("./copilotAccount");
const copilotSettings_1 = require("./copilotSettings");
const deviceId_1 = require("./deviceId");
const hopChain_1 = require("./hopChain");
const pluginData_1 = require("./pluginData");
const subAgentRegistry_1 = require("./subAgentRegistry");
// Precedence: process env (CI / one-off) → ~/.copilot/settings.json →
// the Copilot account's public email (copilotAccount.ts: looked up once with
// Copilot's own credential, then read from copilot-account.json) → a live
// `gh api user` only when that lookup could not run → OS username. Reva API
// keys and CODE_USER_SCOPE are bound to a real mailbox (e.g. Gmail), so a
// private GitHub email needs REVA_USER_EMAIL set.
function resolveUserEmail(env = process.env) {
    const fromEnv = env.REVA_USER_EMAIL?.trim();
    if (fromEnv)
        return fromEnv;
    const fromSettings = (0, copilotSettings_1.readCopilotSettingsReva)().userEmail?.trim();
    if (fromSettings)
        return fromSettings;
    // Cached per Copilot sign-in, so a hook no longer depends on a live GitHub
    // call: a failed call used to swap the email for the OS username (→ 401).
    const account = (0, copilotAccount_1.resolveCopilotAccountEmail)({ pluginDataDir: (0, pluginData_1.resolvePluginDataDir)() });
    if (account.email)
        return account.email;
    // Only when the account lookup could not run; if it ran and found no
    // public email, gh would read the same profile and find none either.
    const ghEmail = account.known ? undefined : (0, deviceId_1.readGithubEmail)();
    if (ghEmail)
        return ghEmail;
    try {
        return os.userInfo().username;
    }
    catch {
        return 'unknown-user';
    }
}
// Which surface this session runs on, reported as context.sessionEntryPoint
// on every request (and stored per session in active-sessions). The agent
// itself is already named by context.agentType, so these carry no
// 'copilot-' prefix.
//
//   the GitHub Copilot desktop app        -> 'Copilot Desktop'
//   any terminal outside an editor        -> 'cli'
//   an editor's integrated terminal       -> 'ide-<editor>'  (ide-vscode, ide-cursor, …)
//   an editor that does not name itself   -> 'ide'
//
// DESKTOP APP: it runs the Copilot runtime (copilot-sdk-runtime-*) with
// GITHUB_COPILOT_INTEGRATION_ID=copilot-developer-app — the id Copilot itself
// uses to say which product is calling. But the runtime STRIPS that variable
// before starting a hook (it is set on the runtime process but absent from
// hook processes), so it cannot be the only check. What does reach
// the hook is COPILOT_MCP_CIMD_CLIENT_ID_URL, which the app sets to its own
// OAuth client metadata, https://github.com/copilot/desktop/client-metadata.json
// — the app naming itself as the Copilot desktop client. Neither is set by
// the Copilot CLI or VS Code Copilot Chat. A surface that names itself is
// checked first; anything else falls through to the checks below rather than
// being guessed into a label.
//
// The Copilot CLI sets no entrypoint variable of its own (checked against every
// env name 1.0.104 reads), so for the CLI detection rests on what the EDITOR
// puts in the terminal's environment. Being in an editor is TERM_PROGRAM=vscode,
// VSCODE_GIT_IPC_HANDLE (survives tmux overwriting TERM_PROGRAM) or
// VSCODE_CODE_CACHE_PATH (extension host).
//
// WHICH editor is read from its user-data folder, not from TERM_PROGRAM:
// VS Code forks (Cursor, Windsurf) set TERM_PROGRAM=vscode too, so that value
// cannot tell them apart, while each keeps its own folder (Code, Cursor,
// Windsurf, Code - Insiders). See resolveEditor. When nothing names the
// editor the answer is 'ide' — never a default editor, which would be a
// wrong-but-plausible label in a field policies match on.
//
// VS CODE COPILOT CHAT runs the Copilot runtime inside the editor, not in a
// terminal: none of the variables above reach its hooks (its only marker,
// GITHUB_COPILOT_INTEGRATION_ID=vscode-chat, is stripped like the desktop
// app's). What does identify it is the process chain — the hook runs under
// copilot-runtime.exe, started by Code.exe. So when nothing in the
// environment names the surface, the hook's parent processes are checked for
// a KNOWN editor executable (see editorFromProcessName). That walk costs about
// a second on Windows, so it runs once per session and the result is saved
// with the session in active-sessions (resolveSessionEntrypointForSession).
//
// REVA_SESSION_ENTRYPOINT lets an operator name a surface nothing detects; it
// sits after the editor checks so an exported value cannot mislabel an editor
// session.
//
// THESE STRINGS ARE POLICY-VISIBLE: a policy matching 'ide-vscode', 'cli' or
// 'Copilot Desktop' breaks if they are renamed, so changing them is a
// breaking change.
exports.DESKTOP_ENTRYPOINT = 'Copilot Desktop';
exports.DESKTOP_INTEGRATION_ID = 'copilot-developer-app';
const DESKTOP_CLIENT_PATH = /\/copilot\/desktop\//i;
function isCopilotDesktop(env) {
    return (env.GITHUB_COPILOT_INTEGRATION_ID?.trim().toLowerCase() === exports.DESKTOP_INTEGRATION_ID ||
        DESKTOP_CLIENT_PATH.test(env.COPILOT_MCP_CIMD_CLIENT_ID_URL || ''));
}
exports.CLI_ENTRYPOINT = 'cli';
exports.IDE_ENTRYPOINT = 'ide';
exports.IDE_ENTRYPOINT_PREFIX = 'ide-';
function inEditor(env) {
    return (env.TERM_PROGRAM?.trim().toLowerCase() === 'vscode' ||
        Boolean(env.VSCODE_GIT_IPC_HANDLE?.trim()) ||
        Boolean(env.VSCODE_CODE_CACHE_PATH?.trim()));
}
// Split on both separators so a Windows path parses on any OS.
function pathSegments(value) {
    return (value || '').split(/[\\/]+/).filter(Boolean);
}
// The segment just before `marker` (case-insensitive), e.g. 'Code' in
// …/Roaming/Code/CachedData/<hash>.
function segmentBefore(value, marker) {
    const segments = pathSegments(value);
    const i = segments.findIndex((seg) => seg.toLowerCase() === marker.toLowerCase());
    return i > 0 ? segments[i - 1] : undefined;
}
// 'Code.exe' -> 'Code'; macOS 'Code Helper (Plugin)' -> 'Code'.
function executableName(value) {
    const base = pathSegments(value).pop();
    if (!base)
        return undefined;
    const name = base.replace(/\.exe$/i, '').replace(/\s+Helper\b.*$/i, '').trim();
    return name || undefined;
}
function normalizeEditorName(name) {
    const lower = name.trim().toLowerCase();
    if (lower === 'code')
        return 'vscode';
    if (lower === 'code - insiders' || lower === 'code-insiders')
        return 'vscode-insiders';
    return lower.replace(/\s+/g, '-');
}
// The editor named by its own user-data folder, or undefined — never a
// default. On Windows (VS Code 1.143.1) these look like the lines below; the
// same folder names apply on macOS (~/Library/Application Support/Code/…) and
// Linux (~/.config/Code/…):
//   VSCODE_CODE_CACHE_PATH   …\Roaming\Code\CachedData\<hash>               (extension host)
//   VSCODE_GIT_ASKPASS_MAIN  …\Roaming\Code\User\globalStorage\vscode.git\… (integrated terminal)
//   VSCODE_GIT_ASKPASS_NODE  …\Microsoft VS Code\Code.exe                   (integrated terminal)
function resolveEditor(env = process.env) {
    const name = segmentBefore(env.VSCODE_CODE_CACHE_PATH, 'CachedData') ||
        segmentBefore(env.VSCODE_GIT_ASKPASS_MAIN, 'User') ||
        executableName(env.VSCODE_GIT_ASKPASS_NODE);
    return name ? normalizeEditorName(name) : undefined;
}
function resolveSessionEntrypoint(env = process.env) {
    if (isCopilotDesktop(env))
        return exports.DESKTOP_ENTRYPOINT;
    if (inEditor(env)) {
        const editor = resolveEditor(env);
        return editor ? exports.IDE_ENTRYPOINT_PREFIX + editor : exports.IDE_ENTRYPOINT;
    }
    const declared = env.REVA_SESSION_ENTRYPOINT?.trim();
    if (declared)
        return declared;
    return exports.CLI_ENTRYPOINT;
}
// Only these executables count as an editor — an unknown parent (node,
// powershell, github.exe, a terminal) is never guessed into one. macOS app
// bundles are matched by their .app folder because the binary inside may be a
// generic helper.
const EDITOR_EXECUTABLES = {
    code: 'vscode',
    'code - insiders': 'vscode-insiders',
    'code-insiders': 'vscode-insiders',
    cursor: 'cursor',
    windsurf: 'windsurf',
};
const EDITOR_APP_BUNDLES = [
    [/\/Visual Studio Code - Insiders\.app\//i, 'vscode-insiders'],
    [/\/Visual Studio Code\.app\//i, 'vscode'],
    [/\/Cursor\.app\//i, 'cursor'],
    [/\/Windsurf\.app\//i, 'windsurf'],
];
// 'C:\…\Microsoft VS Code\Code.exe' -> 'vscode'; anything not an editor -> undefined.
function editorFromProcessName(nameOrPath) {
    if (!nameOrPath)
        return undefined;
    const slashed = nameOrPath.replace(/\\/g, '/');
    for (const [bundle, editor] of EDITOR_APP_BUNDLES) {
        if (bundle.test(slashed))
            return editor;
    }
    const exe = executableName(nameOrPath)?.toLowerCase();
    return exe ? EDITOR_EXECUTABLES[exe] : undefined;
}
const PROCESS_WALK_DEPTH = 12;
const PROCESS_LOOKUP_TIMEOUT_MS = 8000;
// One PowerShell call walks the chain (a CIM query per level). Sent as
// -EncodedCommand: a multi-line script on stdin does not run reliably.
function windowsAncestors(startPid) {
    const script = [
        `$p = ${Math.trunc(startPid)}`,
        `for ($i = 0; $i -lt ${PROCESS_WALK_DEPTH} -and $p -gt 0; $i++) {`,
        `  $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -Property Name,ExecutablePath,ParentProcessId`,
        '  if (-not $x) { break }',
        '  if ($x.ExecutablePath) { $x.ExecutablePath } else { $x.Name }',
        '  $p = [int]$x.ParentProcessId',
        '}',
    ].join('\n');
    const out = (0, node_child_process_1.execFileSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: PROCESS_LOOKUP_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function unixAncestors(startPid) {
    const names = [];
    let pid = startPid;
    for (let i = 0; i < PROCESS_WALK_DEPTH && pid > 1; i++) {
        const out = (0, node_child_process_1.execFileSync)('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: PROCESS_LOOKUP_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const match = out.match(/^(\d+)\s+(.+)$/);
        if (!match)
            break;
        names.push(match[2]);
        pid = Number(match[1]);
    }
    return names;
}
// The executables above this hook, nearest first; empty when the lookup fails.
function listAncestorProcesses(startPid = process.ppid) {
    try {
        return process.platform === 'win32' ? windowsAncestors(startPid) : unixAncestors(startPid);
    }
    catch {
        return [];
    }
}
// The nearest known editor among this hook's parent processes, or undefined.
function findEditorInProcessTree(list = listAncestorProcesses) {
    for (const name of list()) {
        const editor = editorFromProcessName(name);
        if (editor)
            return editor;
    }
    return undefined;
}
// resolveSessionEntrypoint plus the parent-process check, run at most once
// per session: its answer — an editor, or none — is saved in active-sessions
// and reused, so a failed or slow lookup is never repeated on every hook.
// Order: desktop app → editor environment → editor parent process →
// REVA_SESSION_ENTRYPOINT → cli.
function resolveSessionEntrypointForSession(opts) {
    const env = opts.env ?? process.env;
    if (isCopilotDesktop(env) || inEditor(env))
        return resolveSessionEntrypoint(env);
    let editor = opts.sessionId ? (0, activeSessions_1.getSessionEntry)(opts.agentId, opts.sessionId, opts.pluginDataDir)?.editorFromProcess : undefined;
    if (editor === undefined && opts.allowProcessLookup !== false && opts.pluginDataDir && opts.sessionId) {
        editor = (opts.findEditor ?? findEditorInProcessTree)() ?? null;
        (0, activeSessions_1.recordSessionEditor)(opts.agentId, opts.sessionId, editor, opts.pluginDataDir);
    }
    if (editor)
        return exports.IDE_ENTRYPOINT_PREFIX + editor;
    return resolveSessionEntrypoint(env);
}
function resolveAgentContext(configuredAgentId, hookInput) {
    const isSubAgent = Boolean(hookInput.agent_id);
    return {
        agentId: configuredAgentId,
        isSubAgent,
        subAgentId: hookInput.agent_id,
        subAgentType: hookInput.agent_type,
    };
}
// One place that decides who is calling for preToolUse / postToolUse:
//   1. Copilot subagent — sessionId registered at its kickoff
//      (subAgentRegistry.ts).
//   2. Subagent in the Claude-compatible payload shape — same session_id
//      plus agent_id on the input.
//   3. The top-level agent.
function resolveCaller(configuredAgentId, hookInput, pluginDataDir) {
    const registered = (0, subAgentRegistry_1.resolveSubAgent)(hookInput.session_id, pluginDataDir);
    if (registered) {
        return {
            agentId: configuredAgentId,
            isSubAgent: true,
            subAgentId: registered.subAgentId,
            subAgentType: registered.agentType,
            sessionId: registered.rootSessionId,
            hops: registered.lineage,
            hopSessionId: hookInput.session_id,
        };
    }
    const agentCtx = resolveAgentContext(configuredAgentId, hookInput);
    return {
        ...agentCtx,
        sessionId: hookInput.session_id,
        hops: agentCtx.isSubAgent
            ? (0, hopChain_1.resolveSubAgentLineage)(hookInput.session_id, agentCtx.subAgentId, pluginDataDir)
            : (0, hopChain_1.loadAgentHops)(hookInput.session_id, pluginDataDir),
        hopSessionId: hookInput.session_id,
    };
}
