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
exports.readGithubEmail = readGithubEmail;
exports.readOsHardwareId = readOsHardwareId;
exports.resolveMachineId = resolveMachineId;
exports.resolveAgentId = resolveAgentId;
exports._resetDeviceIdCacheForTests = _resetDeviceIdCacheForTests;
exports.osFamily = osFamily;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const copilotAccount_1 = require("./copilotAccount");
const pluginData_1 = require("./pluginData");
// Identity helpers. The Cedar `Agent` id comes from copilotAccount.ts (the
// Copilot account's analytics_tracking_id — see that file). The machine id is
// separate: context.machineId and User.registeredMachineIds.
// The user's GitHub email, for the principal — only a REAL address: the
// public profile email `gh api user` returns. Nothing is ever composed from
// the login: a `<login>@users.noreply.github.com` stand-in is not a mailbox
// and not a Reva user, so sending one only produced 401s against a token
// bound to the real address. No public email → undefined (identity.ts then
// moves on; set REVA_USER_EMAIL for a private email).
//
// No timeout of our own: a cold `gh api user` was measured at ~3.9 s, and a
// 3 s cap silently swapped the email for the OS username (→ 401). The hook's
// own timeoutSec in hooks.json still bounds a gh that never returns.
function readGithubEmail() {
    try {
        const out = (0, node_child_process_1.execFileSync)('gh', ['api', 'user', '--jq', '.email'], {
            encoding: 'utf8',
        }).trim();
        // gh prints "null" for an account with no public email.
        return out && out !== 'null' && out.includes('@') ? out : undefined;
    }
    catch {
        // gh missing or unauthenticated
        return undefined;
    }
}
// The OS's own machine id, and only that. There is deliberately no stand-in:
// a random id saved per plugin made one PC show up in Reva as several
// machines (the real MachineGuid on one surface, a plugin's random id on
// another). No real id → undefined, and nothing is registered.
//
// The read is given far more than it needs: the first `reg.exe` of a session
// was measured at ~2.06 s on Windows (later ones ~40 ms), and the old 2 s cap
// turned that cold start into "no id". The hook's own timeoutSec still bounds
// a read that never returns.
const OS_READ_TIMEOUT_MS = 10000;
const MACHINE_ID_FILE = 'machine-id';
function readMacHardwareId() {
    try {
        const out = (0, node_child_process_1.execFileSync)('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
            encoding: 'utf8',
            timeout: OS_READ_TIMEOUT_MS,
        });
        return out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1];
    }
    catch {
        return undefined;
    }
}
function readLinuxMachineId() {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
            const id = fs.readFileSync(p, 'utf8').trim();
            if (id)
                return id;
        }
        catch {
            // try next
        }
    }
    return undefined;
}
// reg.exe by its full path, so the read does not depend on the hook's PATH.
function readWindowsMachineGuid() {
    const reg = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    try {
        const out = (0, node_child_process_1.execFileSync)(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: OS_READ_TIMEOUT_MS, windowsHide: true });
        return out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)?.[1];
    }
    catch {
        return undefined;
    }
}
function readOsHardwareId() {
    switch (process.platform) {
        case 'darwin':
            return readMacHardwareId();
        case 'linux':
            return readLinuxMachineId();
        case 'win32':
            return readWindowsMachineGuid();
        default:
            return undefined;
    }
}
// A GUID (Windows, macOS) or a 32-hex systemd machine-id (Linux).
function isMachineId(value) {
    const v = value?.trim() ?? '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{32}$/i.test(v);
}
// The REAL id, saved after one successful OS read so later hooks reuse it
// instead of each starting reg.exe. Only a value the OS returned is ever
// written here.
function readSavedMachineId(dataDir) {
    if (!dataDir)
        return undefined;
    try {
        const saved = fs.readFileSync(path.join(dataDir, MACHINE_ID_FILE), 'utf8').trim();
        return isMachineId(saved) ? saved : undefined;
    }
    catch {
        return undefined;
    }
}
function saveMachineId(dataDir, id) {
    if (!dataDir)
        return;
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, MACHINE_ID_FILE), id, 'utf8');
    }
    catch {
        // best effort — the next hook reads the OS again
    }
}
let cachedAgentId;
let cachedMachineId;
// `readOs` is for tests only.
function resolveMachineId(pluginDataDir, readOs = readOsHardwareId) {
    if (!cachedMachineId) {
        const saved = readSavedMachineId(pluginDataDir);
        if (saved) {
            cachedMachineId = saved;
        }
        else {
            const fromOs = readOs()?.trim();
            if (isMachineId(fromOs)) {
                cachedMachineId = fromOs;
                saveMachineId(pluginDataDir, fromOs);
            }
        }
    }
    return cachedMachineId;
}
// The Copilot account's id for the Cedar `Agent` entity — see
// copilotAccount.ts. `allowLookup: false` reads the on-disk cache only (no gh
// process), for hooks with a tight time budget.
function resolveAgentId(opts = {}) {
    if (!cachedAgentId) {
        cachedAgentId = (0, copilotAccount_1.resolveCopilotAccountId)({ pluginDataDir: (0, pluginData_1.resolvePluginDataDir)(), allowLookup: opts.allowLookup });
    }
    return cachedAgentId;
}
/** Test helper — clears memoized ids between cases. */
function _resetDeviceIdCacheForTests() {
    cachedAgentId = undefined;
    cachedMachineId = undefined;
}
// Normalized OS family recorded on the Agent entity (operatingSystems) at
// session start. Normalized rather than raw
// process.platform so a policy author need not know macOS is "darwin". THESE
// STRINGS ARE POLICY-VISIBLE: a policy matching "macos" breaks if they change.
// Anything unrecognized passes through as-is rather than being bucketed into
// a wrong-but-plausible value.
function osFamily(platform = process.platform) {
    switch (platform) {
        case 'win32':
            return 'windows';
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        default:
            return platform;
    }
}
