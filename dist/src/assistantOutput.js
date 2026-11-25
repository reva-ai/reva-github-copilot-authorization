"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truncateAssistantOutput = truncateAssistantOutput;
// Reva truncates a trace's stored output at 16 KiB. Stay under that so the
// summarize request is not rejected as invalid.
const MAX_OUTPUT_BYTES = 16 * 1024;
/** Trim and truncate to Reva's stored-output budget (UTF-8 byte length). */
function truncateAssistantOutput(text) {
    const trimmed = (text || '').trim();
    if (!trimmed)
        return '';
    const buf = Buffer.from(trimmed, 'utf8');
    if (buf.length <= MAX_OUTPUT_BYTES)
        return trimmed;
    // A cut through the middle of a multi-byte character decodes to U+FFFD;
    // drop that fragment rather than send it.
    return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8').replace(/�+$/, '');
}
