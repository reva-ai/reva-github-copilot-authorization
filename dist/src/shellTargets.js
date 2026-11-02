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
exports.MAX_SHELL_RESOURCES = void 0;
exports.literalDirOf = literalDirOf;
exports.expandHome = expandHome;
exports.resolveAgainst = resolveAgainst;
exports.extractShellTargets = extractShellTargets;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
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
exports.MAX_SHELL_RESOURCES = 10;
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
function existsSafe(absolutePath) {
    try {
        return fs.existsSync(absolutePath);
    }
    catch {
        return false;
    }
}
function hasWildcard(value) {
    return /[*?]/.test(value);
}
// Directory portion of a glob, stopping at the first wildcard segment — no
// real folder is named "*", so no path policy could match a wildcard id.
function literalDirOf(patternValue) {
    const segments = patternValue.replace(/\\/g, '/').split('/');
    const literal = [];
    for (const seg of segments) {
        if (/[*?{}[\]]/.test(seg))
            break;
        literal.push(seg);
    }
    if (literal.length === segments.length && literal.length > 0) {
        literal.pop();
    }
    return literal.join('/') || '.';
}
// path.resolve doesn't expand "~"; both sh and PowerShell do. Without this
// "~/Desktop/x" would resolve INSIDE the repo — a policy bypass.
function expandHome(pathValue) {
    if (pathValue === '~')
        return os.homedir();
    if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
        return path.join(os.homedir(), pathValue.slice(2));
    }
    return pathValue;
}
function resolveAgainst(cwd, pathValue) {
    return path.resolve(cwd, expandHome(pathValue));
}
function baseName(pathValue) {
    return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}
// Quote-aware scan, one entry per command segment. Segment breaks are ';',
// '|' and newlines OUTSIDE quotes, so a regex argument like "a|b" doesn't
// split the command.
function scanSegments(command) {
    const segments = [];
    let tokens = [];
    let quoted = [];
    let current = '';
    let literal = '';
    let quote;
    const endToken = () => {
        if (current)
            tokens.push(current);
        current = '';
    };
    const endSegment = () => {
        endToken();
        if (tokens.length)
            segments.push({ tokens, quoted });
        tokens = [];
        quoted = [];
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) {
                quote = undefined;
                if (literal)
                    quoted.push(literal);
                literal = '';
            }
            else {
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
function isPathCandidate(token, cwd) {
    if (!token)
        return false;
    // Parameters (-Raw), variables ($env:X), splats (@x), cmd variables (%X%),
    // and .NET type literals ([System.IO.File]) are never resources.
    if (/^[-$`@%[]/.test(token))
        return false;
    // URLs are never local paths.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token))
        return false;
    if (existsSafe(resolveAgainst(cwd, token)))
        return true;
    // cmd.exe / Windows switches (/c, /s, /q, /f:x) contain a slash but are not
    // paths; a real short root path would already have matched the exists
    // check above.
    if (/^\/[a-z0-9?]{1,3}(:\S*)?$/i.test(token))
        return false;
    // Characters found in expressions, redirections and regexes but
    // effectively never in a path that does not already exist.
    if (/[()'"=|<>;&{}]/.test(token))
        return false;
    if (token.includes('/') || token.includes('\\'))
        return true;
    const base = baseName(token);
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1;
}
// A quoted literal counts only when it is unmistakably a path: it exists, or
// it contains a path separator. Quoted prose like "version 1.2" is not.
function isQuotedPathCandidate(literal, cwd) {
    const value = literal.trim();
    if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return false;
    if (/[*?]/.test(value) === false && existsSafe(resolveAgainst(cwd, value)))
        return true;
    return (value.includes('/') || value.includes('\\')) && !/[()=|<>;&{}\s]/.test(value);
}
// Every distinct filesystem path a shell command appears to touch, deduped by
// resolved absolute path, in first-seen order.
function extractShellTargets(command, cwd) {
    const seen = new Set();
    const targets = [];
    const add = (token) => {
        // A wildcard must never survive into a resource id.
        const literal = hasWildcard(token) ? literalDirOf(token) : token;
        const absolute = resolveAgainst(cwd, literal);
        if (seen.has(absolute))
            return;
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
                if (isPathCandidate(token, cwd))
                    add(token);
            }
        }
        for (const literal of segment.quoted) {
            if (isQuotedPathCandidate(literal, cwd))
                add(literal.trim());
        }
    }
    return targets;
}
