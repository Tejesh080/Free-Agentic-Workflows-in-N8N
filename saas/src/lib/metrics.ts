/**
 * Overview metrics.
 *
 * Only numbers the database can actually support. There is no "estimated ROI"
 * tile, because nothing here measures revenue; and no conversion rate is shown
 * when no outcomes have been recorded, because a rate over zero observations is
 * not a small number, it is an absent one.
 */
import type { Tx } from './db/client';

export interface Overview {
  leadsTotal: number;
  tiers: { HOT: number; WARM: number; COLD: number; DISQUALIFIED: number };
  qualifiedRate: number | null;
  pendingApprovals: number;
  expiredApprovals: number;
  evidence: { supported: number; total: number } | null;
  latency: { p50: number | null; p95: number | null };
  costUsd: number;
  runs: { succeeded: number; failed: number; inFlight: number };
  outcomes: { state: string; count: number }[];
  crm: { provider: string; status: string; lastSuccessAt: Date | null } | null;
}

export async function loadOverview(tx: Tx): Promise<Overview> {
  const counts = await tx.one<{
    total: number;
    hot: number;
    warm: number;
    cold: number;
    dq: number;
    scored: number;
  }>(
    `select count(*)::int as total,
            count(*) filter (where latest_tier = 'HOT')::int as hot,
            count(*) filter (where latest_tier = 'WARM')::int as warm,
            count(*) filter (where latest_tier = 'COLD')::int as cold,
            count(*) filter (where latest_tier = 'DISQUALIFIED')::int as dq,
            count(*) filter (where latest_tier is not null)::int as scored
       from leads where archived_at is null`,
  );

  const approvals = await tx.one<{ pending: number; expired: number }>(
    `select count(*) filter (where status = 'pending' and expires_at > now())::int as pending,
            count(*) filter (where status = 'expired' or (status = 'pending' and expires_at <= now()))::int as expired
       from approval_requests`,
  );

  const evidence = await tx.one<{ supported: number; total: number }>(
    `select count(*) filter (where supported)::int as supported, count(*)::int as total
       from lead_evidence`,
  );

  const runs = await tx.one<{
    succeeded: number;
    failed: number;
    in_flight: number;
    p50: number | null;
    p95: number | null;
    cost: string | null;
  }>(
    `select count(*) filter (where status = 'succeeded')::int as succeeded,
            count(*) filter (where status in ('failed','dead_letter'))::int as failed,
            count(*) filter (where status in ('queued','dispatched','running'))::int as in_flight,
            (percentile_disc(0.5) within group (order by latency_ms))::int as p50,
            (percentile_disc(0.95) within group (order by latency_ms))::int as p95,
            coalesce(sum(cost_usd), 0)::text as cost
       from executions`,
  );

  const outcomes = await tx.query<{ state: string; count: number }>(
    `select state::text as state, count(*)::int as count from lead_outcomes
      group by state order by count desc`,
  );

  const crm = await tx.one<{ provider: string; status: string; last_success_at: Date | null }>(
    `select provider, status, last_success_at from integrations order by created_at limit 1`,
  );

  // A qualified rate over zero leads is meaningless, so report absence.
  const qualifiedRate =
    counts && counts.total > 0
      ? (counts.hot + counts.warm) / counts.total
      : null;

  return {
    leadsTotal: counts?.total ?? 0,
    tiers: {
      HOT: counts?.hot ?? 0,
      WARM: counts?.warm ?? 0,
      COLD: counts?.cold ?? 0,
      DISQUALIFIED: counts?.dq ?? 0,
    },
    qualifiedRate,
    pendingApprovals: approvals?.pending ?? 0,
    expiredApprovals: approvals?.expired ?? 0,
    evidence: evidence && evidence.total > 0 ? evidence : null,
    latency: { p50: runs?.p50 ?? null, p95: runs?.p95 ?? null },
    costUsd: Number(runs?.cost ?? 0),
    runs: {
      succeeded: runs?.succeeded ?? 0,
      failed: runs?.failed ?? 0,
      inFlight: runs?.in_flight ?? 0,
    },
    outcomes,
    crm: crm
      ? { provider: crm.provider, status: crm.status, lastSuccessAt: crm.last_success_at }
      : null,
  };
}
