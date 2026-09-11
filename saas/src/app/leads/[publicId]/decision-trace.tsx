/**
 * The decision trace.
 *
 * Reads the receipt and renders one line per stage of the pipeline. Two rules
 * make it trustworthy rather than decorative:
 *
 *   1. A stage that did not run is shown, with the reason it did not run. A
 *      trace that silently omits what was skipped is a worse audit than no
 *      trace at all, because it reads as though nothing was skipped.
 *   2. Nothing here is inferred. Every line comes from a stored field —
 *      actions_taken, actions_skipped, verification, governance — so the screen
 *      cannot claim a step happened that the receipt does not record.
 */

export interface TraceReceipt {
  score: number | null;
  tier: string | null;
  decision: string;
  rubric_version: string | null;
  score_components: { signal: string; value: string; points: number; supported?: boolean }[];
  verification: Record<string, unknown>;
  governance: Record<string, unknown>;
  actions_taken: Record<string, unknown>[];
  actions_skipped: { action: string; reason: string }[];
  crm_result: Record<string, unknown> | null;
}

type Mark = 'done' | 'held' | 'skip' | 'fail';

interface Step {
  mark: Mark;
  name: string;
  detail: string;
  why?: string;
}

const GLYPH: Record<Mark, string> = { done: '✓', held: '◐', skip: '○', fail: '✕' };

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildSteps(input: {
  receipt: TraceReceipt | null;
  executionStatus: string | null;
  dryRun: boolean;
  evidenceCount: number;
  pendingApproval: { action: string; policy_reason: string } | null;
  source: string;
}): Step[] {
  const steps: Step[] = [];

  steps.push({
    mark: 'done',
    name: 'Ingest',
    detail: `accepted from ${input.source}`,
  });

  if (!input.receipt) {
    steps.push({
      mark: input.executionStatus === 'failed' ? 'fail' : 'held',
      name: 'Qualification',
      detail:
        input.executionStatus === 'failed'
          ? 'execution failed; see the dead-letter record'
          : `execution ${input.executionStatus ?? 'queued'}`,
    });
    return steps;
  }

  const r = input.receipt;

  steps.push({
    mark: 'done',
    name: 'Qualification',
    detail: `${r.score_components.length} constrained signal${r.score_components.length === 1 ? '' : 's'} returned`,
    why: 'the model chose from a closed value set per signal; it never returned a number',
  });

  const supported = num(r.verification['supported']);
  const total = num(r.verification['total']) ?? input.evidenceCount;
  const allSupported = supported !== undefined && total !== undefined && supported === total;
  steps.push({
    mark: supported === undefined ? 'skip' : allSupported ? 'done' : 'held',
    name: 'Evidence',
    detail:
      supported === undefined
        ? 'no verification recorded'
        : `${supported}/${total} quotes located in the source text`,
    why: allSupported
      ? undefined
      : 'an unsupported quote earns no points and can incur a penalty',
  });

  steps.push({
    mark: 'done',
    name: 'Score',
    detail: `${r.score ?? '—'} — ${r.tier ?? 'no tier'}`,
    why: r.rubric_version
      ? `deterministic rubric ${r.rubric_version}; thresholds, not judgement`
      : undefined,
  });

  const govDecision = str(r.governance['decision']);
  const govRisk = str(r.governance['risk_level']);
  steps.push({
    mark: govDecision === 'deny' ? 'fail' : govDecision === 'escalate' ? 'held' : 'done',
    name: 'Governance',
    detail: govDecision
      ? `${govDecision}${govRisk ? ` (risk ${govRisk})` : ''}`
      : 'no governed action requested',
    why: str(r.governance['reason']),
  });

  const crmActions = r.actions_taken.filter((a) => String(a['action'] ?? '').startsWith('crm_'));
  const crmSkips = r.actions_skipped.filter((a) => a.action.startsWith('crm_'));
  if (crmActions.length > 0) {
    steps.push({
      mark: 'done',
      name: 'CRM',
      detail: crmActions
        .map((a) => `${String(a['action'])} → ${String(a['object_id'] ?? 'no id')}`)
        .join(', '),
      why: input.dryRun
        ? 'dry run: the id is derived from the payload digest, no CRM call was made'
        : undefined,
    });
  }
  for (const skip of crmSkips) {
    steps.push({ mark: 'skip', name: 'CRM', detail: `${skip.action} skipped`, why: skip.reason });
  }

  // An action that is waiting on a human is reported once, as held. The engine
  // also records it in actions_skipped (it genuinely did not run), but showing
  // both lines reads as two separate outcomes for one action.
  const outreachSkips = r.actions_skipped.filter(
    (a) => a.action.startsWith('outreach') && a.action !== input.pendingApproval?.action,
  );
  const outreachActions = r.actions_taken.filter((a) =>
    String(a['action'] ?? '').startsWith('outreach'),
  );
  if (input.pendingApproval) {
    steps.push({
      mark: 'held',
      name: 'Outreach',
      detail: `${input.pendingApproval.action} awaiting approval`,
      why: input.pendingApproval.policy_reason,
    });
  }
  for (const a of outreachActions) {
    steps.push({ mark: 'done', name: 'Outreach', detail: String(a['action']) });
  }
  for (const skip of outreachSkips) {
    steps.push({ mark: 'skip', name: 'Outreach', detail: `${skip.action} skipped`, why: skip.reason });
  }

  const other = r.actions_skipped.filter(
    (a) => !a.action.startsWith('crm_') && !a.action.startsWith('outreach'),
  );
  for (const skip of other) {
    steps.push({ mark: 'skip', name: 'Skipped', detail: skip.action, why: skip.reason });
  }

  return steps;
}

export function DecisionTrace(props: Parameters<typeof buildSteps>[0]) {
  const steps = buildSteps(props);
  return (
    <div className="trace">
      {steps.map((s, i) => (
        <div className="trace-step" key={`${s.name}-${i}`}>
          <span className={`trace-mark ${s.mark}`} aria-hidden="true">{GLYPH[s.mark]}</span>
          <span className="trace-name">{s.name}</span>
          <span className="trace-detail">
            {s.detail}
            {s.why && <span className="why">{s.why}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
