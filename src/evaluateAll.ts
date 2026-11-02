import { debugLog } from './debug';
import { evaluate } from './rtgClient';
import { CedarActionMapping, CedarRequest, RevaConfig, RtgResult } from './types';

// ONE hook call can touch MANY resources — an apply_patch naming several
// files. Cedar takes one
// resource per request and the hook returns a single decision, so every
// resource is evaluated and the answers composed DENY-IF-ANY: evaluating only
// one would let the rest through, and widening to a common ancestor would
// break Cedar's `in` against the protected subtree. Both fail toward silent
// permission; this fails toward a visible denial.
//
// Evaluated in parallel, so wall-clock stays at about one round trip.

export type AggregateOutcome = 'allow' | 'deny' | 'ask' | 'inactive';

export interface EvaluatedResource {
  mapping: CedarActionMapping;
  result: RtgResult;
}

export interface AggregateResult {
  outcome: AggregateOutcome;
  reason?: string;
  evaluated: EvaluatedResource[];
}

function describe(mapping: CedarActionMapping): string {
  return `${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId}`;
}

export async function evaluateAll(
  cfg: RevaConfig,
  // Each request carries its own traceparent: one span per resource (see
  // trace.ts toolSpanKey).
  requests: { mapping: CedarActionMapping; request: CedarRequest; traceparent: string }[],
  pluginDataDir?: string,
  threadId?: string,
): Promise<AggregateResult> {
  const evaluated: EvaluatedResource[] = await Promise.all(
    requests.map(async ({ mapping, request, traceparent }) => ({
      mapping,
      result: await evaluate(cfg, request, traceparent, pluginDataDir, threadId),
    })),
  );

  for (const { mapping, result } of evaluated) {
    debugLog(
      `<- ${describe(mapping)} => ${result.inactive ? 'inactive' : result.decision}` +
        `${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`,
    );
  }

  // An inactive result is an RTG outage, not a verdict — it neither blocks
  // nor satisfies. A mixed batch is decided by the resources that got a real
  // answer; a wholly inactive batch passes through untouched.
  const active = evaluated.filter((e) => !e.result.inactive);
  if (active.length === 0) {
    return { outcome: 'inactive', evaluated };
  }

  const denied = active.find((e) => e.result.decision === 'deny');
  if (denied) {
    return {
      outcome: 'deny',
      // Name the resource: with N per call, a bare "denied" can't say which
      // file was the problem.
      reason:
        `${denied.result.reason || "Blocked by your organization's security policy."} ` +
        `[resource: ${describe(denied.mapping)}]` +
        (active.length > 1 ? ` (${active.length} resources evaluated for this one tool call)` : ''),
      evaluated,
    };
  }

  const asked = active.find((e) => e.result.decision === 'ask');
  if (asked) {
    return {
      outcome: 'ask',
      reason: `${asked.result.reason || 'conditional policy match'} [resource: ${describe(asked.mapping)}]`,
      evaluated,
    };
  }

  return { outcome: 'allow', evaluated };
}

// The hook writers take one RtgResult. A single-resource call keeps its own
// result unchanged (same reason text as before multi-resource support); a
// multi-resource call is reduced from the aggregate.
export function toHookResult(aggregate: AggregateResult): RtgResult {
  if (aggregate.evaluated.length === 1) return aggregate.evaluated[0].result;
  switch (aggregate.outcome) {
    case 'inactive':
      return { decision: 'allow', inactive: true };
    case 'deny':
      return { decision: 'deny', reason: aggregate.reason };
    case 'ask':
      return { decision: 'ask', reason: aggregate.reason };
    default:
      return { decision: 'allow' };
  }
}
