"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writePreToolUseDecision = writePreToolUseDecision;
exports.writePromptDecision = writePromptDecision;
exports.writePostToolUseDecision = writePostToolUseDecision;
/**
 * Copilot CLI native preToolUse decision shape (camelCase hooks).
 * Fail-open (inactive): emit nothing so Copilot's own permission flow runs.
 */
function writePreToolUseDecision(result) {
    if (result.inactive) {
        process.exit(0);
    }
    const permissionDecision = result.decision === 'allow' ? 'allow' : result.decision === 'ask' ? 'ask' : 'deny';
    const output = { permissionDecision };
    if (permissionDecision === 'deny') {
        output.permissionDecisionReason = result.reason || "Blocked by your organization's security policy.";
    }
    else if (permissionDecision === 'ask') {
        output.permissionDecisionReason =
            result.reason || 'Requires manual approval per Reva governance policy';
    }
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
}
/**
 * Copilot command-hook userPromptSubmitted output is often ignored for
 * blocking (docs: modifiedPrompt only for SDK hooks). Still emit
 * additionalContext on ask/deny for surfaces that honor it; never emit an
 * explicit allow.
 */
function writePromptDecision(result) {
    if (result.inactive) {
        process.exit(0);
    }
    if (result.decision === 'deny' || result.decision === 'ask') {
        process.stdout.write(JSON.stringify({
            additionalContext: `Reva governance: ${result.decision === 'deny' ? 'this prompt was denied by policy' : 'elevated review required'} (${result.reason || 'policy match'}). Individual tool calls will still be evaluated.`,
        }));
    }
    process.exit(0);
}
/**
 * postToolUse cannot undo the tool. Prefer additionalContext; Copilot also
 * accepts modifiedResult on some surfaces — we only inject context here.
 */
function writePostToolUseDecision(result) {
    if (result.inactive) {
        process.exit(0);
    }
    if (result.decision === 'deny' || result.decision === 'ask') {
        process.stdout.write(JSON.stringify({
            additionalContext: `Reva governance: tool result ${result.decision === 'deny' ? 'denied' : 'requires review'} (${result.reason || 'policy match'})`,
        }));
    }
    process.exit(0);
}
