import * as path from 'node:path';
import { CedarActionName } from './types';

// apply_patch envelope parsing: each file a patch names becomes its own
// Cedar request.
//
// Copilot CLI offers apply_patch to newer GPT models and its prompt tells
// them to use it instead of shell commands for file changes — so creates,
// edits, deletes and moves can all arrive here rather than as a shell
// command. Copilot sends toolArgs as the bare patch STRING, not JSON, which
// normalize.ts wraps as { raw: "<patch>" }:
//
//   *** Begin Patch
//   *** Delete File: tests/test.js
//   *** End Patch
//
// Grammar markers of the apply_patch envelope:
//   "*** Add File: "    <path>   → write
//   "*** Update File: " <path>   → edit (or a move, if "*** Move to:" follows)
//   "*** Delete File: " <path>   → write (DELETE_ACTION)
//   "*** Move to: "     <path>   → write on the source + write on the destination

// The shared action vocabulary has no `delete`; a deletion is a write to the
// file.
export const DELETE_ACTION: CedarActionName = 'write';

const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';

export interface PatchTarget {
  actionName: CedarActionName;
  absolutePath: string;
}

// The patch text from whichever field the host used: Copilot's bare-string
// toolArgs (→ raw), or a structured field on other hosts/builds.
export function patchTextOf(toolInput: Record<string, any>): string {
  for (const key of ['raw', 'input', 'patch', 'command']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function parseApplyPatchTargets(patchText: string, cwd: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  const resolve = (p: string): string => path.resolve(cwd, p);
  // An Update hunk's action is not known until we see whether a "Move to:"
  // line follows it, so it is held back until the next marker or EOF.
  let pendingUpdate: string | undefined;

  const flushPendingUpdate = (): void => {
    if (pendingUpdate !== undefined) {
      targets.push({ actionName: 'edit', absolutePath: resolve(pendingUpdate) });
      pendingUpdate = undefined;
    }
  };

  for (const rawLine of patchText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith(ADD_FILE_MARKER)) {
      flushPendingUpdate();
      targets.push({ actionName: 'write', absolutePath: resolve(line.slice(ADD_FILE_MARKER.length).trim()) });
    } else if (line.startsWith(DELETE_FILE_MARKER)) {
      flushPendingUpdate();
      targets.push({ actionName: DELETE_ACTION, absolutePath: resolve(line.slice(DELETE_FILE_MARKER.length).trim()) });
    } else if (line.startsWith(UPDATE_FILE_MARKER)) {
      flushPendingUpdate();
      pendingUpdate = line.slice(UPDATE_FILE_MARKER.length).trim();
    } else if (line.startsWith(MOVE_TO_MARKER)) {
      // A move is two resources: the content leaves the source and arrives
      // at the destination. Deny-if-any over both is the only way a policy
      // protecting either end holds.
      const destination = line.slice(MOVE_TO_MARKER.length).trim();
      if (pendingUpdate !== undefined) {
        targets.push({ actionName: DELETE_ACTION, absolutePath: resolve(pendingUpdate) });
        pendingUpdate = undefined;
      }
      targets.push({ actionName: 'write', absolutePath: resolve(destination) });
    }
  }
  flushPendingUpdate();

  // Dedupe on action+path: the same file updated twice is one resource, but
  // the same path as both a delete and a write (a move onto itself) stays two.
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.actionName}\u0000${t.absolutePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
