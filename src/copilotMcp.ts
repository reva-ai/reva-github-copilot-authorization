import { readEvents, resolveCopilotHome } from './copilotModel';
import { discoverMcpServers } from './mcpDiscovery';

// Which MCP server a Copilot tool call goes to. Copilot names MCP tools
// "<server>-<tool>" (arxiv-search_papers, github-mcp-server-list_copilot_spaces)
// and its hook payload carries no server field. Two sources, in order:
//
//   1. The session record. Copilot writes the call's tool.execution_start to
//      session-state/<sessionId>/events.jsonl BEFORE it runs preToolUse, with
//      data.mcpServerName / mcpConfigServerName / mcpToolName (CLI 1.0.105).
//      The tool name already encodes the server, so the most recent event for
//      that tool name is the right one even when calls run in parallel.
//   2. The configured servers (mcpDiscovery.ts): the longest configured name
//      that prefixes the tool name as "<name>-". Used when no record is found.
//
// Nothing found → undefined, and the call stays a plain invokeTool. Never
// throws: this runs on the PreToolUse path, which fails closed.

export interface CopilotMcpTool {
  // The server's name as configured — slugged by mapping.ts into the
  // MCPServer id, the same way discovery slugs it.
  server: string;
  tool: string;
}

export interface ResolveMcpOptions {
  toolName: string;
  // Session records to search, in order (a subagent's own, then its root's).
  sessionIds: string[];
  cwd: string;
  copilotHome?: string;
  // For tests: the home directory discovery reads user config from.
  home?: string;
}

const EXECUTION_START = '"tool.execution_start"';

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// null = the record shows this call is NOT an MCP call (no config guess then);
// undefined = no record of it.
function fromSessionRecord(opts: ResolveMcpOptions): CopilotMcpTool | null | undefined {
  const home = opts.copilotHome || resolveCopilotHome();
  const needle = `"toolName":${JSON.stringify(opts.toolName)}`;
  for (const sessionId of [...new Set(opts.sessionIds.filter(Boolean))]) {
    const lines = readEvents(sessionId, home);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes(EXECUTION_START) || !line.includes(needle)) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.type !== 'tool.execution_start' || e.data?.toolName !== opts.toolName) continue;
      const server = nonEmpty(e.data.mcpConfigServerName) || nonEmpty(e.data.mcpServerName);
      if (!server) return null; // the latest call by this name is not an MCP call
      const tool = nonEmpty(e.data.mcpToolName) || stripPrefix(opts.toolName, server) || opts.toolName;
      return { server, tool };
    }
  }
  return undefined;
}

function stripPrefix(toolName: string, server: string): string | undefined {
  return toolName.startsWith(`${server}-`) ? toolName.slice(server.length + 1) || undefined : undefined;
}

function fromConfiguredServers(opts: ResolveMcpOptions): CopilotMcpTool | undefined {
  const names = discoverMcpServers(opts.cwd, opts.home)
    .map((s) => s.displayName || s.name)
    .sort((a, b) => b.length - a.length);
  for (const server of names) {
    const tool = stripPrefix(opts.toolName, server);
    if (tool) return { server, tool };
  }
  return undefined;
}

export function resolveCopilotMcpTool(opts: ResolveMcpOptions): CopilotMcpTool | undefined {
  try {
    const recorded = fromSessionRecord(opts);
    if (recorded !== undefined) return recorded ?? undefined;
    return fromConfiguredServers(opts);
  } catch {
    return undefined;
  }
}
