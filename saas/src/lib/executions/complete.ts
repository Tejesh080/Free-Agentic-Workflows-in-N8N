/**
 * Applying an engine completion.
 *
 * Everything authorization-relevant has already been settled by the time this
 * runs: the signature was verified against the raw bytes, and the organization
 * came from the execution row we dispatched, not from the payload. What is left
 * is making the state transition exactly once.
 */
import type { Principal, Tx } from '../db/client';
import type { CallbackPayload } from '../schemas';

export interface CallbackTarget {
  executionId: string;
  orgId: string;
  leadId: string | null;
  status: string;
  completedAt: Date | null;
  dryRun: boolean;
}

export interface Delivery {
  nonce: string;
  signedAt: Date;
  bodyDigest: string;
}

export type CompletionOutcome =
  | { kind: 'applied'; receiptId: string; approvalId: string | null }
  | { kind: 'already_complete' }
  | { kind: 'replayed' };

const TERMINAL = new Set(['succeeded', 'failed', 'dead_letter']);

export function systemPrincipal(orgId: string, reason: string): Principal {
  return { kind: 'system', orgId, reason };
}

export async function applyCompletion(
  tx: Tx,
  target: CallbackTarget,
  payload: CallbackPayload,
  delivery: Delivery,
): Promise<CompletionOutcome> {
  // Single-use. The unique index on nonce is the enforcement; this select is
  // only so a replay can be answered without raising.
  const seen = await tx.one<{ id: string }>(
    `select id from callback_deliveries where nonce = $1`,
    [delivery.nonce],
  );
  if (seen) return { kind: 'replayed' };

  await tx.query(
    `insert into callback_deliveries (org_id, execution_id, nonce, signed_at, body_digest)
     values ($1,$2,$3,$4,$5)`,
    [target.orgId, target.executionId, delivery.nonce, delivery.signedAt.toISOString(), delivery.bodyDigest],
  );

  // A second completion with a fresh nonce is a legitimate engine retry, not an
  // attack — but it must not be able to overwrite a finished decision. The
  // delivery is recorded (it happened) and the state is left alone.
  if (TERMINAL.has(target.status)) {
    return { kind: 'already_complete' };
  }

  const failed = payload.status === 'failed';

  await tx.query(
    `update executions set
        status = $2::execution_status,
        engine_execution_id = coalesce($3, engine_execution_id),
        prompt_versions = $4::jsonb,
        model_metadata = $5::jsonb,
        error = $6::jsonb,
        started_at = coalesce($7::timestamptz, started_at),
        completed_at = coalesce($8::timestamptz, now()),
        cost_usd = coalesce($9, cost_usd),
        latency_ms = case
          when $7::timestamptz is not null
          then (extract(epoch from (coalesce($8::timestamptz, now()) - $7::timestamptz)) * 1000)::int
          else latency_ms end
      where id = $1`,
    [
      target.executionId,
      failed ? 'failed' : 'succeeded',
      payload.engine_execution_id ?? null,
      JSON.stringify(payload.prompt_versions),
      JSON.stringify(payload.model_metadata),
      payload.error ? JSON.stringify(payload.error) : null,
      payload.started_at ?? null,
      payload.completed_at ?? null,
      payload.cost_usd ?? null,
    ],
  );

  if (target.leadId) {
    await tx.query(
      `update leads set
          status = $2::lead_status,
          latest_score = coalesce($3, latest_score),
          latest_tier = coalesce($4::lead_tier, latest_tier)
        where id = $1`,
      [
        target.leadId,
        failed ? 'failed' : 'qualified',
        payload.score ?? null,
        payload.tier ?? null,
      ],
    );

    // Evidence is replaced per execution, not accumulated across them: the rows
    // are keyed to the run that produced them.
    for (const item of payload.evidence) {
      await tx.query(
        `insert into lead_evidence (org_id, lead_id, execution_id, signal, value, quote, source_field, supported, points)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          target.orgId,
          target.leadId,
          target.executionId,
          item.signal,
          item.value,
          item.quote ?? null,
          item.source_field ?? null,
          item.supported,
          item.points,
        ],
      );
    }
  }

  const rubric = await tx.one<{ id: string }>(
    `select rubric_version_id as id from executions where id = $1`,
    [target.executionId],
  );

  const receipt = await tx.one<{ id: string }>(
    `insert into decision_receipts (
        org_id, lead_id, execution_id, trace_id, decision, score, tier,
        rubric_version_id, rubric_version, prompt_versions, model_metadata,
        score_components, verification, governance, actions_taken, actions_skipped, crm_result
     ) select $1,$2,$3,e.trace_id,$4,$5,$6::lead_tier,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb
         from executions e where e.id = $3
     returning id`,
    [
      target.orgId,
      target.leadId,
      target.executionId,
      payload.decision,
      payload.score ?? null,
      payload.tier ?? null,
      rubric?.id ?? null,
      payload.rubric_version ?? null,
      JSON.stringify(payload.prompt_versions),
      JSON.stringify(payload.model_metadata),
      JSON.stringify(payload.score_components),
      JSON.stringify(payload.verification),
      JSON.stringify(payload.governance),
      JSON.stringify(payload.actions_taken),
      JSON.stringify(payload.actions_skipped),
      payload.crm_result ? JSON.stringify(payload.crm_result) : null,
    ],
  );
  if (!receipt) throw new Error('receipt insert produced no row');

  let approvalId: string | null = null;
  if (payload.approval?.required) {
    const frozen = JSON.stringify(payload.approval.payload);
    const digest = await tx.one<{ d: string }>(`select md5($1) as d`, [frozen]);
    const approval = await tx.one<{ id: string }>(
      `insert into approval_requests (
          org_id, lead_id, execution_id, trace_id, action, risk_level, policy_reason, payload, payload_digest
       ) select $1,$2,$3,e.trace_id,$4::approval_action,$5,$6,$7::jsonb,$8
           from executions e where e.id = $3
       on conflict do nothing
       returning id`,
      [
        target.orgId,
        target.leadId,
        target.executionId,
        payload.approval.action,
        payload.approval.risk_level,
        payload.approval.policy_reason,
        frozen,
        digest?.d ?? '',
      ],
    );
    approvalId = approval?.id ?? null;
  }

  await tx.query(
    `insert into audit_events (org_id, actor_type, action, target_type, target_id, trace_id, after)
     select $1,'engine','execution.completed','execution',$2::uuid::text,e.trace_id,$3::jsonb
       from executions e where e.id = $2::uuid`,
    [
      target.orgId,
      target.executionId,
      JSON.stringify({
        status: payload.status,
        tier: payload.tier ?? null,
        score: payload.score ?? null,
        actions_taken: payload.actions_taken.length,
        actions_skipped: payload.actions_skipped.length,
      }),
    ],
  );

  return { kind: 'applied', receiptId: receipt.id, approvalId };
}
