/**
 * Assembling a lead's full decision trace.
 *
 * One query set, used by both the API and the Lead Detail screen, so the screen
 * cannot show something the API would not return. The shape is the audit story:
 * identity, the evidence a model produced, what verification made of it, the
 * deterministic score components, the governance outcome, what ran, and what
 * did not run and why.
 */
import type { Tx } from '../db/client';

export interface LeadDetail {
  lead: Record<string, unknown>;
  executions: Record<string, unknown>[];
  receipt: Record<string, unknown> | null;
  evidence: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  timeline: TimelineEntry[];
}

export interface TimelineEntry {
  at: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export async function loadLeadDetail(tx: Tx, publicId: string): Promise<LeadDetail | undefined> {
  const lead = await tx.one<Record<string, unknown>>(
    `select id, public_id, status, source, email, first_name, last_name, company_name,
            job_title, phone, website, notes, latest_score, latest_tier,
            created_at, updated_at, latest_execution_id
       from leads where public_id = $1`,
    [publicId],
  );
  // Undefined covers both "no such lead" and "belongs to another organization":
  // row level security already made them the same answer.
  if (!lead) return undefined;
  const leadId = lead['id'] as string;

  const executions = await tx.query<Record<string, unknown>>(
    `select id, trace_id, status, dry_run, attempt, replay_of, rubric_version_id,
            prompt_versions, model_metadata, error, queued_at, dispatched_at,
            started_at, completed_at, latency_ms, cost_usd
       from executions where lead_id = $1 order by created_at desc`,
    [leadId],
  );

  const receipt = await tx.one<Record<string, unknown>>(
    `select r.*, rv.version as rubric_version_label, rv.definition as rubric_definition
       from decision_receipts r
       left join rubric_versions rv on rv.id = r.rubric_version_id
      where r.lead_id = $1 order by r.created_at desc limit 1`,
    [leadId],
  );

  const evidence = await tx.query<Record<string, unknown>>(
    `select signal, value, quote, source_field, supported, points, execution_id, created_at
       from lead_evidence where lead_id = $1 order by created_at asc, signal asc`,
    [leadId],
  );

  const approvals = await tx.query<Record<string, unknown>>(
    `select a.id, a.action, a.status, a.risk_level, a.policy_reason, a.payload,
            a.requested_at, a.expires_at, a.decided_at, a.decision_note, a.executed_at,
            u.email as decided_by_email
       from approval_requests a
       left join users u on u.id = a.decided_by
      where a.lead_id = $1 order by a.requested_at desc`,
    [leadId],
  );

  const outcomes = await tx.query<Record<string, unknown>>(
    `select state, source, value_usd, occurred_at, note from lead_outcomes
      where lead_id = $1 order by occurred_at desc`,
    [leadId],
  );

  return {
    lead,
    executions,
    receipt: receipt ?? null,
    evidence,
    approvals,
    outcomes,
    timeline: buildTimeline({ lead, executions, receipt: receipt ?? null, approvals, outcomes }),
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

export function buildTimeline(input: {
  lead: Record<string, unknown>;
  executions: Record<string, unknown>[];
  receipt: Record<string, unknown> | null;
  approvals: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  entries.push({
    at: iso(input.lead['created_at']),
    kind: 'ingest',
    summary: `Lead received from ${String(input.lead['source'] ?? 'api')}`,
  });

  for (const e of input.executions) {
    entries.push({
      at: iso(e['queued_at']),
      kind: 'execution',
      summary: e['dry_run'] ? 'Execution queued (dry run)' : 'Execution queued (live)',
      detail: { trace_id: e['trace_id'], attempt: e['attempt'] },
    });
    if (e['completed_at']) {
      entries.push({
        at: iso(e['completed_at']),
        kind: e['status'] === 'failed' ? 'failure' : 'completion',
        summary:
          e['status'] === 'failed'
            ? 'Execution failed'
            : `Execution finished in ${String(e['latency_ms'] ?? '?')} ms`,
        detail: { trace_id: e['trace_id'], error: e['error'] ?? undefined },
      });
    }
  }

  if (input.receipt) {
    entries.push({
      at: iso(input.receipt['created_at']),
      kind: 'decision',
      summary: `Decision: ${String(input.receipt['decision'])}${
        input.receipt['tier'] ? ` — ${String(input.receipt['tier'])} (${String(input.receipt['score'])})` : ''
      }`,
      detail: { rubric_version: input.receipt['rubric_version'] },
    });
  }

  for (const a of input.approvals) {
    entries.push({
      at: iso(a['requested_at']),
      kind: 'approval_requested',
      summary: `${String(a['action'])} held for approval (${String(a['risk_level'])})`,
      detail: { reason: a['policy_reason'] },
    });
    if (a['decided_at']) {
      entries.push({
        at: iso(a['decided_at']),
        kind: 'approval_decided',
        summary: `${String(a['action'])} ${String(a['status'])}`,
        detail: { by: a['decided_by_email'], note: a['decision_note'] },
      });
    }
  }

  for (const o of input.outcomes) {
    entries.push({
      at: iso(o['occurred_at']),
      kind: 'outcome',
      summary: `Outcome recorded: ${String(o['state'])}`,
      detail: { source: o['source'], value_usd: o['value_usd'] },
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
