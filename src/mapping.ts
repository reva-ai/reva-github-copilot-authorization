import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseApplyPatchTargets, patchTextOf } from './applyPatch';
import { resolveMcpServerIdentity } from './mcpServerIdentity';
import { resolvePluginDataDir } from './pluginData';
import { extractShellTargets, literalDirOf, MAX_SHELL_RESOURCES, resolveAgainst } from './shellTargets';
import { CedarActionMapping, CedarEntityRef, ToolMapping } from './types';

// Copilot runtime names (bash, view, …) plus PascalCase aliases (Bash, Read,
// …) so either camelCase or PascalCase hook configs work.
const EDIT_TOOLS = new Set([
  'edit',
  'Edit',
  'str_replace_editor',
  'MultiEdit',
  'NotebookEdit',
]);

// apply_patch carries its targets inside the patch text, not in a path
// argument, so it gets its own per-file mapping (mapToolCall) rather than the
// single-path EDIT_TOOLS branch.
const APPLY_PATCH_TOOLS = new Set(['apply_patch']);

const SHELL_TOOLS = new Set(['bash', 'Bash', 'powershell', 'PowerShell', 'shell']);
const READ_TOOLS = new Set(['view', 'Read', 'read_file']);
const WRITE_TOOLS = new Set(['create', 'Write', 'write_file']);
const GLOB_TOOLS = new Set(['glob', 'Glob']);
const GREP_TOOLS = new Set(['grep', 'Grep', 'rg']);
const SPAWN_TOOLS = new Set(['task', 'Task', 'Agent']);

function looksLikeFile(pathValue: string): boolean {
  const base = pathValue.replace(/\\/g, '/').split('/').pop() || '';
  return base.includes('.') && !base.startsWith('.');
}

function classifyPath(absolutePath: string): 'File' | 'Directory' {
  try {
    return fs.statSync(absolutePath).isDirectory() ? 'Directory' : 'File';
  } catch {
    return looksLikeFile(absolutePath) ? 'File' : 'Directory';
  }
}

function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function toPortableId(absolutePath: string, cwd: string): string {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return absolutePath;
  const repoName = path.basename(repoRoot);
  const rel = path.relative(repoRoot, absolutePath);
  if (rel === '') return repoName;
  if (rel.startsWith('..')) return absolutePath;
  return `${repoName}/${rel.split(path.sep).join('/')}`;
}

function baseName(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}

function extension(pathValue: string): string | undefined {
  const base = baseName(pathValue);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1) : undefined;
}

function fileProperties(portableId: string): Record<string, any> {
  const ext = extension(portableId);
  return { name: baseName(portableId), ...(ext ? { extension: ext } : {}) };
}

function directoryProperties(portableId: string): Record<string, any> {
  return { path: portableId };
}

function buildAncestorParents(portableId: string): CedarEntityRef[] {
  if (path.isAbsolute(portableId)) return [];
  const segments = portableId.split('/');
  const repoName = segments[0];
  if (!repoName) return [];
  const parents: CedarEntityRef[] = [];
  for (let i = segments.length - 1; i > 1; i--) {
    parents.push({ type: 'Directory', id: segments.slice(0, i).join('/') });
  }
  if (segments.length > 1) {
    parents.push({ type: 'Directory', id: repoName });
  }
  parents.push({ type: 'Repository', id: repoName });
  return parents;
}

// One executeBash mapping for one path a shell command touches. With no
// identifiable path, the working directory is the honest resource.
function shellMapping(
  absolutePath: string,
  cwd: string,
  command: string,
  forceType?: 'File' | 'Directory',
): CedarActionMapping {
  const type = forceType || classifyPath(absolutePath);
  const id = toPortableId(absolutePath, cwd);
  return {
    actionName: 'executeBash',
    resourceType: type,
    resourceId: id,
    resourceProperties: type === 'File' ? fileProperties(id) : directoryProperties(id),
    resourceParents: buildAncestorParents(id),
    command,
  };
}

function shellCommandOf(toolInput: Record<string, any>): string {
  return toolInput.command || toolInput.cmd || '';
}

function pathFromInput(toolInput: Record<string, any>, cwd: string, fallback = cwd): string {
  const raw =
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.path ||
    toolInput.target_file ||
    toolInput.targetFile ||
    fallback;
  return resolveAgainst(cwd, String(raw));
}

export function mapToolToCedar(
  toolName: string,
  toolInput: Record<string, any>,
  cwd: string,
): CedarActionMapping {
  if (SHELL_TOOLS.has(toolName)) {
    // Single-resource view: the first path the command touches. The hooks use
    // mapToolCall, which evaluates every path.
    const command = shellCommandOf(toolInput);
    const [first] = extractShellTargets(command, cwd);
    return first ? shellMapping(first, cwd, command) : shellMapping(path.resolve(cwd), cwd, command, 'Directory');
  }

  if (READ_TOOLS.has(toolName)) {
    const absolutePath = pathFromInput(toolInput, cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'read',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const absolutePath = pathFromInput(toolInput, cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'write',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const absolutePath = pathFromInput(toolInput, cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'edit',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (GLOB_TOOLS.has(toolName)) {
    const pattern: string = toolInput.pattern || toolInput.glob || '';
    const absoluteDir = resolveAgainst(cwd, toolInput.path || literalDirOf(pattern) || cwd);
    const id = toPortableId(absoluteDir, cwd);
    return {
      actionName: 'glob',
      resourceType: 'Directory',
      resourceId: id,
      resourceProperties: directoryProperties(id),
      resourceParents: buildAncestorParents(id),
      pattern,
      tool: toolName,
    };
  }

  if (GREP_TOOLS.has(toolName)) {
    const pattern: string = toolInput.pattern || toolInput.query || '';
    const absoluteTarget = resolveAgainst(cwd, toolInput.path || cwd);
    const type = classifyPath(absoluteTarget);
    const id = toPortableId(absoluteTarget, cwd);
    return {
      actionName: 'grep',
      resourceType: type,
      resourceId: id,
      resourceProperties: type === 'File' ? fileProperties(id) : directoryProperties(id),
      resourceParents: buildAncestorParents(id),
      pattern,
      tool: toolName,
    };
  }

  if (SPAWN_TOOLS.has(toolName)) {
    const subagentType: string =
      toolInput.subagent_type ||
      toolInput.subagentType ||
      toolInput.agent_type ||
      toolInput.agentType ||
      toolInput.name ||
      'subagent';
    return {
      actionName: 'spawn',
      resourceType: 'SubAgent',
      resourceId: subagentType,
      resourceProperties: { agentType: subagentType },
    };
  }

  // mcp__server__tool or mcp/server/tool
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp/')) {
    const parts = toolName.startsWith('mcp__') ? toolName.split('__') : toolName.split('/');
    const token = parts[1] || 'unknown-server';
    const tool = parts.slice(2).join(toolName.startsWith('mcp__') ? '__' : '/') || toolName;

    // Resolve to the same slug discovery ingests, so the MCPServer parent
    // below points at an entity that actually exists. Fully fault-tolerant
    // inside (see mcpServerIdentity.ts): this runs on the PreToolUse path,
    // where authorize.ts fails CLOSED, so a cache miss must degrade to the
    // raw token and never throw.
    const server = resolveMcpServerIdentity(token, resolvePluginDataDir());
    const label = server.displayName || server.slug;
    return {
      actionName: 'invokeTool',
      resourceType: 'Tool',
      resourceId: `${server.slug}/${tool}`,
      resourceProperties: {
        name: tool,
        description: `MCP tool "${tool}" on server "${label}"`,
        connectionType: 'mcp',
      },
      resourceParents: [{ type: 'MCPServer', id: server.slug }],
    };
  }

  return {
    actionName: 'invokeTool',
    resourceType: 'Tool',
    resourceId: toolName,
    resourceProperties: {
      name: toolName,
      description: `GitHub Copilot built-in tool: ${toolName}`,
    },
  };
}

// Entry point for the hooks: every resource one tool call touches. Most tools
// touch exactly one (mapToolToCedar). apply_patch touches every file its
// envelope names — Add → write, Update → edit, Delete → write, Move → write on
// both ends — each evaluated on its own (evaluateAll.ts). A patch whose
// envelope names no file yields no mappings, which the hooks fail closed on:
// a mutation with an unknown target must not pass.
export function mapToolCall(toolName: string, toolInput: Record<string, any>, cwd: string): ToolMapping {
  if (APPLY_PATCH_TOOLS.has(toolName)) {
    const targets = parseApplyPatchTargets(patchTextOf(toolInput), cwd);
    return {
      mappings: targets.map((t) => {
        const id = toPortableId(t.absolutePath, cwd);
        return {
          actionName: t.actionName,
          resourceType: 'File',
          resourceId: id,
          resourceProperties: fileProperties(id),
          resourceParents: buildAncestorParents(id),
          tool: toolName,
        };
      }),
    };
  }
  if (SHELL_TOOLS.has(toolName)) {
    // Every path the command touches is evaluated (deny-if-any), so a policy
    // on a protected folder holds however the command is spelled.
    const command = shellCommandOf(toolInput);
    const targets = extractShellTargets(command, cwd);
    if (targets.length === 0) {
      return { mappings: [shellMapping(path.resolve(cwd), cwd, command, 'Directory')] };
    }
    if (targets.length > MAX_SHELL_RESOURCES) {
      return { mappings: [], overCap: true, candidateCount: targets.length };
    }
    return { mappings: targets.map((absolute) => shellMapping(absolute, cwd, command)) };
  }
  return { mappings: [mapToolToCedar(toolName, toolInput, cwd)] };
}
