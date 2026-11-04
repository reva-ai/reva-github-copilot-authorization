"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCopilotMcpTool = resolveCopilotMcpTool;
const copilotModel_1 = require("./copilotModel");
const mcpDiscovery_1 = require("./mcpDiscovery");
const EXECUTION_START = '"tool.execution_start"';
function nonEmpty(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
// null = the record shows this call is NOT an MCP call (no config guess then);
// undefined = no record of it.
function fromSessionRecord(opts) {
    const home = opts.copilotHome || (0, copilotModel_1.resolveCopilotHome)();
    const needle = `"toolName":${JSON.stringify(opts.toolName)}`;
    for (const sessionId of [...new Set(opts.sessionIds.filter(Boolean))]) {
        const lines = (0, copilotModel_1.readEvents)(sessionId, home);
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line.includes(EXECUTION_START) || !line.includes(needle))
                continue;
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (e?.type !== 'tool.execution_start' || e.data?.toolName !== opts.toolName)
                continue;
            const server = nonEmpty(e.data.mcpConfigServerName) || nonEmpty(e.data.mcpServerName);
            if (!server)
                return null; // the latest call by this name is not an MCP call
            const tool = nonEmpty(e.data.mcpToolName) || stripPrefix(opts.toolName, server) || opts.toolName;
            return { server, tool };
        }
    }
    return undefined;
}
function stripPrefix(toolName, server) {
    return toolName.startsWith(`${server}-`) ? toolName.slice(server.length + 1) || undefined : undefined;
}
function fromConfiguredServers(opts) {
    const names = (0, mcpDiscovery_1.discoverMcpServers)(opts.cwd, opts.home)
        .map((s) => s.displayName || s.name)
        .sort((a, b) => b.length - a.length);
    for (const server of names) {
        const tool = stripPrefix(opts.toolName, server);
        if (tool)
            return { server, tool };
    }
    return undefined;
}
function resolveCopilotMcpTool(opts) {
    try {
        const recorded = fromSessionRecord(opts);
        if (recorded !== undefined)
            return recorded ?? undefined;
        return fromConfiguredServers(opts);
    }
    catch {
        return undefined;
    }
}
