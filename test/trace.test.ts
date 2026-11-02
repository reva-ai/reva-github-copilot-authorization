import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionContext, buildTraceId, deriveSpanId, deriveTraceId, mintTraceId, traceparentHeader } from '../src/trace';

const TOOL_KEY = 'tool:Bash:{"command":"npm test"}';
const OTHER_KEY = 'tool:Bash:{"command":"npm run build"}';

test('a minted trace id is a fresh, well-formed W3C trace id every time', () => {
  const a = mintTraceId();
  const b = mintTraceId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  // One trace per PROMPT — the next prompt must not reuse this one.
  assert.notEqual(a, b);
});

test('a derived span id is a well-formed W3C span id', () => {
  assert.match(deriveSpanId(mintTraceId(), TOOL_KEY), /^[0-9a-f]{16}$/);
});

test('PreToolUse and PostToolUse of ONE tool call land on the same span', () => {
  // The whole reason the span is derived rather than random: the two hooks
  // are separate processes with no shared state, but both see identical
  // tool_name and tool_input, so both compute the same span.
  const traceId = mintTraceId();
  assert.equal(deriveSpanId(traceId, TOOL_KEY), deriveSpanId(traceId, TOOL_KEY));
});

test('different tool calls in the same turn get different spans, under one trace', () => {
  const traceId = mintTraceId();
  const first = deriveSpanId(traceId, TOOL_KEY);
  const second = deriveSpanId(traceId, OTHER_KEY);
  const prompt = deriveSpanId(traceId, 'user-prompt');
  assert.notEqual(first, second);
  assert.notEqual(first, prompt);
  assert.notEqual(second, prompt);
  // …all three still on the one trace for this prompt.
  for (const span of [first, second, prompt]) {
    assert.equal(traceparentHeader(traceId, span).split('-')[1], traceId);
  }
});

test('the same tool call under a DIFFERENT turn gets a different span', () => {
  // Spans are scoped by trace, so an identical command in the next prompt is
  // a new span rather than colliding with the previous turn's.
  assert.notEqual(deriveSpanId(mintTraceId(), TOOL_KEY), deriveSpanId(mintTraceId(), TOOL_KEY));
});

test('the fallback trace id is stable per (session, turn) and differs across turns', () => {
  // Separate hook processes must agree without the cache, so this has to be
  // deterministic — and turn 2 must not reuse turn 1's trace.
  assert.equal(deriveTraceId('sess-1', 1), deriveTraceId('sess-1', 1));
  assert.match(deriveTraceId('sess-1', 1), /^[0-9a-f]{32}$/);
  assert.notEqual(deriveTraceId('sess-1', 1), deriveTraceId('sess-1', 2));
  assert.notEqual(deriveTraceId('sess-1', 1), deriveTraceId('sess-2', 1));
});

test('traceparent is assembled in W3C order: version-trace-span-flags', () => {
  const traceId = mintTraceId();
  const spanId = deriveSpanId(traceId, TOOL_KEY);
  assert.equal(traceparentHeader(traceId, spanId), `00-${traceId}-${spanId}-01`);
});

test('session.id defaults to sessionId, or uses the explicit id if given', () => {
  const traceId = mintTraceId();
  const noId = buildSessionContext('sess-1', 'span-1', traceId);
  assert.equal(noId.id, 'sess-1');
  assert.equal(noId.traceId, traceId);
  const withId = buildSessionContext('sess-1', 'span-1', traceId, 'prompt-xyz');
  assert.equal(withId.id, 'prompt-xyz');
});

test('buildTraceId is a deterministic, well-formed W3C trace id', () => {
  // Every hook process of one Copilot subagent must compute the same trace
  // from its agentId, with no shared state; different subagents must differ.
  const a = buildTraceId('subagent:373f3991-7fdc-4314-9a0d-e09c91e93c0c');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, buildTraceId('subagent:373f3991-7fdc-4314-9a0d-e09c91e93c0c'));
  assert.notEqual(a, buildTraceId('subagent:9d295b18-28b0-48df-8744-fbb1d7d5dbde'));
});
