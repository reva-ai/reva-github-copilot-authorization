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
exports.discoverMcpServers = discoverMcpServers;
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const copilotSettings_1 = require("./copilotSettings");
const mcpServerIdentity_1 = require("./mcpServerIdentity");
const BUILTIN_MCP_SERVERS = ['github-mcp-server'];
function toDiscovered(servers) {
    if (!servers || typeof servers !== 'object')
        return [];
    return Object.entries(servers).map(([name, entry]) => ({
        name: (0, mcpServerIdentity_1.slugifyMcpServerName)(name) || name,
        displayName: name,
        url: typeof entry?.url === 'string' ? entry.url : undefined,
    }));
}
function mcpJsonFileServers(filePath) {
    return toDiscovered((0, copilotSettings_1.readCopilotJsonc)(filePath)?.mcpServers);
}
// First occurrence wins on a slug collision across sources — deterministic
// (.mcp.json, .github/mcp.json, user config, then built-in), so a workspace
// definition takes precedence over the user's own. `home` is for tests.
function discoverMcpServers(cwd, home = os.homedir()) {
    const all = [
        ...mcpJsonFileServers(path.join(cwd, '.mcp.json')),
        ...mcpJsonFileServers(path.join(cwd, '.github', 'mcp.json')),
        ...mcpJsonFileServers(path.join(home, '.copilot', 'mcp-config.json')),
        ...BUILTIN_MCP_SERVERS.map((name) => ({ name: (0, mcpServerIdentity_1.slugifyMcpServerName)(name) || name, displayName: name })),
    ];
    const disabled = new Set((0, copilotSettings_1.readDisabledMcpServers)(path.join(home, '.copilot', 'settings.json')));
    const seen = new Set();
    const result = [];
    for (const entry of all) {
        if (seen.has(entry.name))
            continue;
        if (disabled.has(entry.displayName || entry.name) || disabled.has(entry.name))
            continue;
        seen.add(entry.name);
        result.push(entry);
    }
    return result;
}
