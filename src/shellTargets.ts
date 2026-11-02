import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Every filesystem path a shell command (PowerShell or POSIX sh) appears to
// touch.
//
// Why it matters: a command-text guardrail only matches the spellings it
// lists. On Copilot CLI, once "Remove-Item 'D:\Drivers' -Recurse -Force" is
// blocked, the model can delete the same folder with
//   Add-Type -AssemblyName Microsoft.VisualBasic;
//   [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('D:\Drivers',…)
// which no pattern matches. A first-token heuristic would report that
// as File:D:\Microsoft.VisualBasic; — so a policy protecting D:\Drivers could
// not match either. Reporting the real path lets a path policy hold
// however the command is written.
//
// Still explicitly BEST-EFFORT. This is not a shell parser: anything it cannot
// confidently identify is excluded rather than guessed at, and a command with
// no candidates falls back to the working directory (see mapping.ts).

// Above this many distinct paths one call is denied rather than evaluated
// partially or widened to a common ancestor (either would let a narrower
// path policy be bypassed).
export const MAX_SHELL_RESOURCES = 10;

// PowerShell parameters whose value is never a filesystem path. Their values
// look path-ish (dotted .NET names) and were being reported as files.
const NON_PATH_VALUE_PARAMETERS = new Set([
  '-assemblyname',
  '-typename',
  '-comobject',
  '-namespace',
  '-classname',
  '-name',
  '-propertytype',
  '-membertype',
  '-erroraction',
  '-warningaction',
  '-encoding',
]);

function existsSafe(absolutePath: string): boolean {
  try {
    return fs.existsSync(absolutePath);
  } catch {
    return false;
  }
}

function hasWildcard(value: string): boolean {
  return /[*?]/.test(value);
}

// Directory portion of a glob, stopping at the first wildcard segment — no
// real folder is named "*", so no path policy could match a wildcard id.
export function literalDirOf(patternValue: string): string {
  const segments = patternValue.replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const seg of segments) {
    if (/[*?{}[\]]/.test(seg)) break;
    literal.push(seg);
  }
  if (literal.length === segments.length && literal.length > 0) {
    literal.pop();
  }
  return literal.join('/') || '.';
}

// path.resolve doesn't expand "~"; both sh and PowerShell do. Without this
// "~/Desktop/x" would resolve INSIDE the repo — a policy bypass.
export function expandHome(pathValue: string): string {
  if (pathValue === '~') return os.homedir();
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return path.join(os.homedir(), pathValue.slice(2));
  }
  return pathValue;
}

export function resolveAgainst(cwd: string, pathValue: string): string {
  return path.resolve(cwd, expandHome(pathValue));
}

function baseName(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}

interface ScannedSegment {
  tokens: string[];
  // The content of every quoted string in the segment, kept whole. A path
  // passed as a method argument — DeleteDirectory('D:\Drivers', …) — never
  // becomes a clean token of its own, but it is always a quoted literal.
  quoted: string[];
}

// Quote-aware scan, one entry per command segment. Segment breaks are ';',
// '|' and newlines OUTSIDE quotes, so a regex argument like "a|b" doesn't
// split the command.
function scanSegments(command: string): ScannedSegment[] {
  const segments: ScannedSegment[] = [];
  let tokens: string[] = [];
  let quoted: string[] = [];
  let current = '';
  let literal = '';
  let quote: '"' | "'" | undefined;

  const endToken = (): void => {
    if (current) tokens.push(current);
    current = '';
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) segments.push({ tokens, quoted });
    tokens = [];
    quoted = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        if (literal) quoted.push(literal);
        literal = '';
      } else {
        current += ch;
        literal += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      literal = '';
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      endSegment();
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    current += ch;
  }
  endSegment();
  return segments;
}

// Whether one already-unquoted token names a filesystem path. "Exists on disk"
// is the strongest signal and is checked first, so a real path with awkward
// characters is still recognised while a path-looking expression is not.
function isPathCandidate(token: string, cwd: string): boolean {
  if (!token) return false;
  // Parameters (-Raw), variables ($env:X), splats (@x), cmd variables (%X%),
  // and .NET type literals ([System.IO.File]) are never resources.
  if (/^[-$`@%[]/.test(token)) return false;
  // URLs are never local paths.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (existsSafe(resolveAgainst(cwd, token))) return true;
  // cmd.exe / Windows switches (/c, /s, /q, /f:x) contain a slash but are not
  // paths; a real short root path would already have matched the exists
  // check above.
  if (/^\/[a-z0-9?]{1,3}(:\S*)?$/i.test(token)) return false;
  // Characters found in expressions, redirections and regexes but
  // effectively never in a path that does not already exist.
  if (/[()'"=|<>;&{}]/.test(token)) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  const base = baseName(token);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1;
}

// A quoted literal counts only when it is unmistakably a path: it exists, or
// it contains a path separator. Quoted prose like "version 1.2" is not.
function isQuotedPathCandidate(literal: string, cwd: string): boolean {
  const value = literal.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/[*?]/.test(value) === false && existsSafe(resolveAgainst(cwd, value))) return true;
  return (value.includes('/') || value.includes('\\')) && !/[()=|<>;&{}\s]/.test(value);
}

// Every distinct filesystem path a shell command appears to touch, deduped by
// resolved absolute path, in first-seen order.
export function extractShellTargets(command: string, cwd: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  const add = (token: string): void => {
    // A wildcard must never survive into a resource id.
    const literal = hasWildcard(token) ? literalDirOf(token) : token;
    const absolute = resolveAgainst(cwd, literal);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    targets.push(absolute);
  };

  for (const segment of scanSegments(command)) {
    // Token 0 is the command/cmdlet name, not a resource.
    const args = segment.tokens.slice(1);
    for (let i = 0; i < args.length; i++) {
      if (NON_PATH_VALUE_PARAMETERS.has(args[i].toLowerCase())) {
        i++; // skip the parameter's value too
        continue;
      }
      // PowerShell comma-separated path lists: Get-ChildItem a,b,c
      for (const piece of args[i].split(',')) {
        const token = piece.trim();
        if (isPathCandidate(token, cwd)) add(token);
      }
    }
    for (const literal of segment.quoted) {
      if (isQuotedPathCandidate(literal, cwd)) add(literal.trim());
    }
  }
  return targets;
}
