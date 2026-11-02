// Shell commands that act through code rather than a recognisable command
// name. A command-text guardrail can't see what these do — e.g. after
// "Remove-Item D:\Drivers -Recurse -Force" is blocked, a model can delete the
// same folder via [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory.
// For these the plugin asks a human instead of passing a policy "allow"
// straight through. It never turns a deny into anything weaker — see
// applyIndirectExecutionFloor.
//
// Deliberately narrow: plain cmdlets/commands (Get-ChildItem | Format-Table,
// ls, git status) and read-only .NET calls ([Math]::Round, [IO.Path]::Combine)
// are not flagged, so normal work isn't interrupted.

import { RtgResult } from './types';

interface Rule {
  pattern: RegExp;
  what: string;
}

const POWERSHELL_RULES: Rule[] = [
  { pattern: /\bAdd-Type\b/i, what: 'loads .NET code with Add-Type' },
  { pattern: /\b(Invoke-Expression|iex)\b/i, what: 'runs a string as code (Invoke-Expression)' },
  {
    pattern: /\b(powershell|pwsh)(\.exe)?\b[^|;]*\s-(EncodedCommand|enc|ec|e)\s+[A-Za-z0-9+/=]{16,}/i,
    what: 'runs a base64-encoded command',
  },
  { pattern: /\[scriptblock\]::Create/i, what: 'builds a script block from a string' },
  { pattern: /New-Object\s+(-ComObject|-com)\b/i, what: 'drives a COM object' },
  // Static calls on file-system types with a mutating method, written any way
  // ([System.IO.Directory], [IO.File], [Microsoft.VisualBasic.FileIO.FileSystem]).
  {
    pattern:
      /\[(System\.)?IO\.(File|Directory|FileInfo|DirectoryInfo)\]::(Delete|Move|Replace|Copy|Write|Create|Encrypt|Decrypt|SetAttributes|SetAccessControl|AppendAll)/i,
    what: 'changes files through .NET System.IO',
  },
  {
    pattern: /FileIO\.FileSystem\]::(Delete|Move|Rename|Copy|Write)/i,
    what: 'changes files through Microsoft.VisualBasic.FileIO',
  },
];

const POSIX_RULES: Rule[] = [
  { pattern: /(^|[;&|]\s*)eval\s/, what: 'runs a string as code (eval)' },
  { pattern: /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, what: 'pipes text into a shell' },
  { pattern: /base64\s+(-d|--decode|-D)\b/, what: 'decodes base64 content' },
  { pattern: /\b(python[0-9.]*|node|perl|ruby|php)\s+-(c|e)\s/, what: 'runs inline interpreter code' },
  { pattern: /\bosascript\s+-e\s/, what: 'runs inline AppleScript' },
  { pattern: /\$\{![A-Za-z_]/, what: 'uses indirect variable expansion' },
];

const POWERSHELL_TOOLS = new Set(['powershell', 'PowerShell']);
const POSIX_TOOLS = new Set(['bash', 'Bash', 'shell']);

// What the command does indirectly, or undefined for an ordinary command.
export function detectIndirectExecution(toolName: string, command: string | undefined): string | undefined {
  if (!command) return undefined;
  const rules = POWERSHELL_TOOLS.has(toolName) ? POWERSHELL_RULES : POSIX_TOOLS.has(toolName) ? POSIX_RULES : [];
  return rules.find((r) => r.pattern.test(command))?.what;
}

// Applied to the PreToolUse result. A deny always stands. An allow, or no
// verdict because Reva is unreachable, becomes `ask`: a command whose effect
// the policy cannot see must not pass silently.
export function applyIndirectExecutionFloor(result: RtgResult, indirect: string | undefined): RtgResult {
  if (!indirect || result.decision === 'deny') return result;
  if (result.decision === 'ask') return result;
  return {
    decision: 'ask',
    reason: `Reva governance: this command ${indirect}, so its effect can't be checked against policy. Approve only if you expect it.`,
  };
}
