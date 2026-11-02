import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapToolToCedar } from '../src/mapping';

describe('mapToolToCedar (Copilot tools)', () => {
  const cwd = process.cwd();

  it('maps bash → executeBash', () => {
    const m = mapToolToCedar('bash', { command: 'ls src' }, cwd);
    assert.equal(m.actionName, 'executeBash');
    assert.equal(m.command, 'ls src');
  });

  it('maps Bash alias the same way', () => {
    const m = mapToolToCedar('Bash', { command: 'pwd' }, cwd);
    assert.equal(m.actionName, 'executeBash');
  });

  it('maps view → read', () => {
    const m = mapToolToCedar('view', { path: 'README.md' }, cwd);
    assert.equal(m.actionName, 'read');
    assert.equal(m.resourceType, 'File');
  });

  it('maps create → write', () => {
    const m = mapToolToCedar('create', { path: 'new-file.ts' }, cwd);
    assert.equal(m.actionName, 'write');
  });

  it('maps edit → edit (apply_patch has its own per-file mapping: applyPatch.test.ts)', () => {
    assert.equal(mapToolToCedar('edit', { path: 'a.ts' }, cwd).actionName, 'edit');
  });

  it('maps task → spawn', () => {
    const m = mapToolToCedar('task', { subagent_type: 'explore' }, cwd);
    assert.equal(m.actionName, 'spawn');
    assert.equal(m.resourceType, 'SubAgent');
    assert.equal(m.resourceId, 'explore');
  });

  it('maps unknown tools → invokeTool', () => {
    const m = mapToolToCedar('web_fetch', { url: 'https://example.com' }, cwd);
    assert.equal(m.actionName, 'invokeTool');
    assert.equal(m.resourceId, 'web_fetch');
  });

  it('maps mcp__server__tool with slugified server id', () => {
    const m = mapToolToCedar('mcp__GitHub_Docs__search', {}, cwd);
    assert.equal(m.actionName, 'invokeTool');
    assert.equal(m.resourceId, 'github-docs/search');
    assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'github-docs' }]);
  });

  it('maps mcp/server/tool Copilot-style names', () => {
    const m = mapToolToCedar('mcp/My_Server/list', {}, cwd);
    assert.equal(m.resourceId, 'my-server/list');
    assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'my-server' }]);
  });
});
