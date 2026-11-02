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
exports.readCopilotSignedInUser = readCopilotSignedInUser;
exports.formatAsUuid = formatAsUuid;
exports.apiBaseFor = apiBaseFor;
exports.readCopilotToken = readCopilotToken;
exports.fetchCopilotUserViaGh = fetchCopilotUserViaGh;
exports.fetchCopilotUser = fetchCopilotUser;
exports.resolveCopilotAccountId = resolveCopilotAccountId;
exports.resolveCopilotAccountEmail = resolveCopilotAccountEmail;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// An ACCOUNT-scoped id for the Cedar `Agent` entity, the same on every
// machine that account signs in from.
//
// Copilot writes no such id to disk. A full search of ~/.copilot (config,
// settings, session-state, session-store.db, logs, ide locks) found only the
// signed-in `login` + `host` in config.json; every UUID there is per-session,
// and the GitHub token lives in the OS credential store as an opaque gho_
// string, not a JWT with claims. The account-level id Copilot does have lives
// server-side, on the record Copilot itself reads:
//
//   GET /copilot_internal/user → analytics_tracking_id
//
// a 32-hex, per-account value (the same on repeated calls, distinct from the
// numeric user id and from organization ids). It is an UNDOCUMENTED GitHub
// endpoint — if GitHub drops or renames the field, the lookup fails and
// REVA_AGENT_ID becomes required, rather than this module guessing at a
// substitute. Cross-machine stability is the property that matters most: the
// same login is expected to resolve to the same id on every machine.
//
// The same lookup also reads the account's PUBLIC profile email (GET /user)
// for the principal. Copilot's token has no user:email scope, so a private
// email is not readable — that is recorded as "looked up, none" (null), and
// identity.ts moves on rather than retrying on every hook.
//
// Resolution, cheapest first:
//   1. The cache in <plugin data>/copilot-account.json, valid only while it
//      was resolved for the login + host Copilot is CURRENTLY signed in as
//      (config.json). A sign-in change invalidates it.
//   2. One lookup with COPILOT'S OWN token — the credential Copilot's /login
//      stored, so the answer describes exactly the account Copilot uses:
//        env COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN (Copilot's own
//        precedence), else the OS credential store:
//          Windows  Credential Manager  "<host>:<login>.copilot-cli",
//                                       "<host>:<login>:github.copilot-cli"
//          macOS    Keychain  service "copilot-cli", account "<host>:<login>"
//                   or "<host>:<login>:github"
//          Linux    secret-tool, same service/account (best-effort, unverified)
//      On Windows the id and email match what the gh path returns. On macOS,
//      reading the Keychain entries asks the user to allow access once.
//   3. If no token is readable, one `gh api` lookup instead, accepted only
//      when gh is authenticated as that same login. Kept as the fallback
//      for when the credential store cannot be read (e.g. a denied Keychain
//      prompt).
//   4. Nothing → undefined. No fallback to the login, the numeric id or a
//      machine id: a different stand-in would split one person into two
//      Agents. config.ts then requires REVA_AGENT_ID.
//
// The token is only ever held in memory for the lookup: it is passed to the
// request process through its environment (never argv), sent only to the
// host Copilot is signed in to, and never written to the cache or the log.
const CACHE_FILE = 'copilot-account.json';
const GH_TIMEOUT_MS = 5000;
// Long enough for one API round trip; the hook's own timeoutSec still bounds it.
const REQUEST_TIMEOUT_MS = 15000;
// PowerShell compiles a small credential reader on first use (~1-2 s).
const CREDENTIAL_TIMEOUT_MS = 15000;
// Short enough to stay inside sessionStart's 10 s even if macOS shows its
// Keychain prompt; a later hook simply tries again.
const KEYCHAIN_TIMEOUT_MS = 8000;
// Copilot CLI's config.json (may start with // comment lines).
function readCopilotSignedInUser(configPath) {
    try {
        const filePath = configPath ||
            (process.env.REVA_COPILOT_CONFIG_PATH?.length ? process.env.REVA_COPILOT_CONFIG_PATH : undefined) ||
            path.join(os.homedir(), '.copilot', 'config.json');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\s*\/\/.*$/gm, '').trim());
        const user = data?.lastLoggedInUser || data?.loggedInUsers?.[0];
        if (typeof user?.login === 'string' && user.login.length > 0) {
            return { host: typeof user.host === 'string' && user.host ? user.host : 'https://github.com', login: user.login };
        }
    }
    catch {
        // missing / unreadable / malformed
    }
    return undefined;
}
// 32 hex chars → 8-4-4-4-12 (UUID shape). Formatting only — the value is
// unchanged.
function formatAsUuid(hex) {
    if (typeof hex !== 'string')
        return undefined;
    const h = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(h))
        return undefined;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function hostnameOf(host) {
    return host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
// REST base for the signed-in host: github.com, GHE.com data residency
// (<sub>.ghe.com), or a GitHub Enterprise Server.
function apiBaseFor(host) {
    const hostname = hostnameOf(host).toLowerCase();
    if (!hostname || hostname === 'github.com')
        return 'https://api.github.com';
    if (hostname.endsWith('.ghe.com'))
        return `https://api.${hostname}`;
    return `https://${hostname}/api/v3`;
}
function asToken(value) {
    const t = value?.trim();
    return t && /^(gho_|ghu_|ghp_|github_pat_)/.test(t) ? t : undefined;
}
// Windows Credential Manager read through CredReadW — the same API Copilot
// stores with. Targets come in through the environment, never the command line.
const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RevaCopilotCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return b;
    } finally { CredFree(p); }
  }
}
"@
foreach ($t in ($env:REVA_CRED_TARGETS -split "\`n")) {
  if (-not $t) { continue }
  $b = [RevaCopilotCred]::Read($t)
  if (-not $b) { continue }
  foreach ($enc in @([Text.Encoding]::UTF8, [Text.Encoding]::Unicode)) {
    $s = $enc.GetString($b).Trim([char]0).Trim()
    if ($s -match '^(gho_|ghu_|ghp_|github_pat_)') { [Console]::Out.Write($s); exit 0 }
  }
}
exit 1
`;
// -EncodedCommand, not `-Command -`: PowerShell runs a stdin script line by
// line, which breaks the multi-line Add-Type block (it exits 0 with no output).
function readWindowsCredential(targets) {
    try {
        const out = (0, node_child_process_1.execFileSync)('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, 'utf16le').toString('base64'),
        ], {
            encoding: 'utf8',
            timeout: CREDENTIAL_TIMEOUT_MS,
            env: { ...process.env, REVA_CRED_TARGETS: targets.join('\n') },
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
        });
        return asToken(out);
    }
    catch {
        return undefined;
    }
}
function readSecret(command, args, timeout) {
    try {
        return asToken((0, node_child_process_1.execFileSync)(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }));
    }
    catch {
        return undefined;
    }
}
// Copilot's own GitHub token for this sign-in, or undefined.
function readCopilotToken(signedIn, env = process.env) {
    for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        const fromEnv = asToken(env[name]);
        if (fromEnv)
            return fromEnv;
    }
    const account = `${signedIn.host}:${signedIn.login}`;
    switch (process.platform) {
        case 'win32':
            return readWindowsCredential([`${account}.copilot-cli`, `${account}:github.copilot-cli`]);
        case 'darwin':
            for (const acct of [account, `${account}:github`]) {
                const token = readSecret('security', ['find-generic-password', '-s', 'copilot-cli', '-a', acct, '-w'], KEYCHAIN_TIMEOUT_MS);
                if (token)
                    return token;
            }
            return undefined;
        case 'linux':
            for (const acct of [account, `${account}:github`]) {
                const token = readSecret('secret-tool', ['lookup', 'service', 'copilot-cli', 'account', acct], GH_TIMEOUT_MS);
                if (token)
                    return token;
            }
            return undefined;
        default:
            return undefined;
    }
}
// Both GETs run in one short-lived Node process so this module stays
// synchronous like its callers. The token rides in that process's
// environment, not its arguments.
const REQUEST_SCRIPT = `
const base = process.env.REVA_GH_API;
const headers = {
  Authorization: 'Bearer ' + process.env.REVA_GH_TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'reva-copilot-plugin',
};
const get = (p) =>
  fetch(base + p, { headers, signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS - 2000}) })
    .then(async (r) => ({ status: r.status, json: r.ok ? await r.json() : undefined }))
    .catch(() => ({ status: 0 }));
Promise.all([get('/copilot_internal/user'), get('/user')]).then(([cu, user]) => {
  process.stdout.write(JSON.stringify({
    login: cu.json && cu.json.login,
    analyticsTrackingId: cu.json && cu.json.analytics_tracking_id,
    email: user.json ? (typeof user.json.email === 'string' && user.json.email.includes('@') ? user.json.email : null) : undefined,
  }));
});
`;
function fetchWithToken(host, token) {
    try {
        const out = (0, node_child_process_1.execFileSync)(process.execPath, ['-e', REQUEST_SCRIPT], {
            encoding: 'utf8',
            timeout: REQUEST_TIMEOUT_MS,
            env: { ...process.env, REVA_GH_API: apiBaseFor(host), REVA_GH_TOKEN: token },
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        const data = JSON.parse(out.trim());
        return {
            login: typeof data?.login === 'string' ? data.login : undefined,
            analyticsTrackingId: typeof data?.analyticsTrackingId === 'string' ? data.analyticsTrackingId : undefined,
            email: typeof data?.email === 'string' || data?.email === null ? data.email : undefined,
        };
    }
    catch {
        return undefined;
    }
}
// One read-only call through gh's own authentication (fallback).
function fetchCopilotUserViaGh(host) {
    const hostname = hostnameOf(host);
    const hostArgs = hostname && hostname !== 'github.com' ? ['--hostname', hostname] : [];
    try {
        const out = (0, node_child_process_1.execFileSync)('gh', ['api', ...hostArgs, 'copilot_internal/user', '--jq', '{login: .login, analytics_tracking_id: .analytics_tracking_id}'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
        const data = JSON.parse(out.trim());
        let email;
        try {
            const raw = (0, node_child_process_1.execFileSync)('gh', ['api', ...hostArgs, 'user', '--jq', '.email'], {
                encoding: 'utf8',
                timeout: GH_TIMEOUT_MS,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            email = raw && raw !== 'null' && raw.includes('@') ? raw : null;
        }
        catch {
            email = undefined;
        }
        return {
            login: typeof data?.login === 'string' ? data.login : undefined,
            analyticsTrackingId: typeof data?.analytics_tracking_id === 'string' ? data.analytics_tracking_id : undefined,
            email,
        };
    }
    catch {
        // gh missing, unauthenticated, no Copilot seat, timed out, or the
        // endpoint/field changed
        return undefined;
    }
}
// Copilot's own credential first, gh only when no token is readable.
function fetchCopilotUser(host, login) {
    const token = readCopilotToken({ host, login });
    if (token) {
        const record = fetchWithToken(host, token);
        if (record?.analyticsTrackingId)
            return record;
    }
    return fetchCopilotUserViaGh(host);
}
function cachePath(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, CACHE_FILE) : undefined;
}
function sameAccount(a, b) {
    return hostnameOf(a.host).toLowerCase() === hostnameOf(b.host).toLowerCase() && a.login.toLowerCase() === b.login.toLowerCase();
}
function readCache(pluginDataDir) {
    const file = cachePath(pluginDataDir);
    if (!file)
        return undefined;
    try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof c?.host === 'string' && typeof c?.login === 'string' && typeof c?.analyticsTrackingId === 'string'
            ? c
            : undefined;
    }
    catch {
        return undefined;
    }
}
function writeCache(entry, pluginDataDir) {
    const file = cachePath(pluginDataDir);
    if (!file)
        return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    }
    catch {
        // best effort — the next process just looks it up again
    }
}
// Look the account up and cache it; undefined unless it describes the
// account Copilot is signed in as.
function lookUpAndCache(signedIn, opts) {
    const record = (opts.fetch || fetchCopilotUser)(signedIn.host, signedIn.login);
    if (!record?.login || record.login.toLowerCase() !== signedIn.login.toLowerCase())
        return undefined;
    if (!formatAsUuid(record.analyticsTrackingId))
        return undefined;
    const entry = {
        host: signedIn.host,
        login: signedIn.login,
        analyticsTrackingId: record.analyticsTrackingId.trim().toLowerCase(),
        ...(record.email !== undefined ? { email: record.email } : {}),
        resolvedAt: new Date().toISOString(),
    };
    writeCache(entry, opts.pluginDataDir);
    return entry;
}
function cachedFor(signedIn, pluginDataDir) {
    const cached = readCache(pluginDataDir);
    return cached && sameAccount(cached, signedIn) ? cached : undefined;
}
function resolveCopilotAccountId(opts = {}) {
    const signedIn = readCopilotSignedInUser(opts.configPath);
    if (!signedIn)
        return undefined;
    const id = formatAsUuid(cachedFor(signedIn, opts.pluginDataDir)?.analyticsTrackingId);
    if (id)
        return id;
    if (opts.allowLookup === false)
        return undefined;
    return formatAsUuid(lookUpAndCache(signedIn, opts)?.analyticsTrackingId);
}
function resolveCopilotAccountEmail(opts = {}) {
    const signedIn = readCopilotSignedInUser(opts.configPath);
    if (!signedIn)
        return { known: false };
    const cached = cachedFor(signedIn, opts.pluginDataDir);
    if (cached && cached.email !== undefined)
        return { email: cached.email ?? undefined, known: true };
    if (opts.allowLookup === false)
        return { known: false };
    const entry = lookUpAndCache(signedIn, opts);
    if (!entry || entry.email === undefined)
        return { known: false };
    return { email: entry.email ?? undefined, known: true };
}
