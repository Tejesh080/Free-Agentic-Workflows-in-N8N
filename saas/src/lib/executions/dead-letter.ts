/**
 * The control plane's dead-letter handling.
 *
 * Three rules, all enforced by the database as well as by this code:
 *
 *   1. A failure record is written once and never edited. What happened is
 *      immutable; what was done about it is a separate set of columns.
 *   2. A replay is a NEW execution that points back at the one it replaces
 *      (`executions.replay_of`), and that the dead letter points forward to
 *      (`dead_letters.replay_execution_id`). Neither overwrites the other.
 *   3. A replay is a human decision. It spends money and may touch a
 *      customer's CRM a second time, so the policy refuses a machine principal.
 */
import type { Principal, Tx } from '../db/client';
import { publicId } from '../leads/ingest';

export type FailureStage = 'dispatch' | 'engine' | 'callback';

export interface DeadLetterInput {
  executionId: string;
  leadId: string | null;
  traceId: string;
  stage: FailureStage;
  error: Record<string, unknown>;
  failingNode?: string | null;
  engineExecutionId?: string | null;
  engineExecutionUrl?: string | null;
  attempt?: number;
}

/**
 * Record a failure. Idempotent per execution: a second failure of the same
 * attempt is the same failure, so the unique index makes a repeat a no-op
 * rather than a duplicate row or an error the caller has to handle.
 */
export async function recordDeadLetter(
  tx: Tx,
  principal: Principal,
  input: DeadLetterInput,
): Promise<string | undefined> {
  const row = await tx.one<{ id: string }>(
    `insert into dead_letters (
        org_id, execution_id, lead_id, trace_id, stage, error,
        failing_node, engine_execution_id, engine_execution_url, attempt
     ) values ($1,$2,$3,$4,$5::failure_stage,$6::jsonb,$7,$8,$9,$10)
     on conflict (execution_id) do nothing
     returning id`,
    [
      principal.orgId,
      input.executionId,
      input.leadId,
      input.traceId,
      input.stage,
      JSON.stringify(input.error),
      input.failingNode ?? null,
      input.engineExecutionId ?? null,
      input.engineExecutionUrl ?? null,
      input.attempt ?? 1,
    ],
  );

  await tx.query(
    `update executions set status = 'dead_letter' where id = $1 and status not in ('succeeded')`,
    [input.executionId],
  );

  await tx.query(
    `insert into audit_events (org_id, actor_type, action, target_type, target_id, trace_id, after)
     values ($1,'system','execution.dead_lettered','execution',$2::uuid::text,$3,$4::jsonb)`,
    [
      principal.orgId,
      input.executionId,
      input.traceId,
      JSON.stringify({ stage: input.stage, failing_node: input.failingNode ?? null }),
    ],
  );

  return row?.id;
}

export type ReplayOutcome =
  | { kind: 'replayed'; deadLetterId: string; executionId: string; traceId: string }
  | { kind: 'not_found' }
  | { kind: 'already_replayed'; status: string };

/**
 * Create a replay execution for a dead letter.
 *
 * Deliberately does NOT reuse the original execution row. Reusing it would
 * destroy the record of the first attempt — the exact thing this table exists
 * to preserve — and would make "how many times did we try" unanswerable.
 */
export async function replayDeadLetter(
  tx: Tx,
  principal: Principal,
  deadLetterId: string,
): Promise<ReplayOutcome> {
  const dl = await tx.one<{
    id: string;
    status: string;
    execution_id: string;
    lead_id: string | null;
    attempt: number;
  }>(
    `select id, status::text as status, execution_id, lead_id, attempt
       from dead_letters where id = $1 for update`,
    [deadLetterId],
  );
  if (!dl) return { kind: 'not_found' };
  if (dl.status !== 'open') return { kind: 'already_replayed', status: dl.status };

  const original = await tx.one<{
    idempotency_key: string;
    dry_run: boolean;
    rubric_version_id: string | null;
  }>(
    `select idempotency_key, dry_run, rubric_version_id from executions where id = $1`,
    [dl.execution_id],
  );
  if (!original) return { kind: 'not_found' };

  const traceId = publicId('trc');
  const replay = await tx.one<{ id: string; trace_id: string }>(
    `insert into executions (
        org_id, lead_id, trace_id, idempotency_key, status, dry_run,
        rubric_version_id, attempt, replay_of
     ) values ($1,$2,$3,$4,'queued',$5,$6,$7,$8)
     returning id, trace_id`,
    [
      principal.orgId,
      dl.lead_id,
      traceId,
      // A new idempotency key, derived from the original plus the attempt. The
      // original key must stay attached to the original execution, or the
      // unique index would refuse the replay and a retry would be impossible.
      `${original.idempotency_key}#replay${dl.attempt + 1}`,
      original.dry_run,
      original.rubric_version_id,
      dl.attempt + 1,
      dl.execution_id,
    ],
  );
  if (!replay) throw new Error('replay execution insert produced no row');

  const updated = await tx.one<{ id: string }>(
    `update dead_letters
        set status = 'replayed', replay_execution_id = $2, replayed_at = now(), replayed_by = $3
      where id = $1 and status = 'open'
      returning id`,
    [deadLetterId, replay.id, principal.kind === 'user' ? principal.userId : null],
  );
  // The policy refuses a machine principal, so no row here means an API key
  // tried to authorise its own retry.
  if (!updated) return { kind: 'not_found' };

  await tx.query(
    `insert into audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, trace_id, after)
     values ($1,$2,$3,'execution.replayed','dead_letter',$4,$5,$6::jsonb)`,
    [
      principal.orgId,
      principal.kind === 'user' ? 'user' : 'system',
      principal.kind === 'user' ? principal.userId : null,
      deadLetterId,
      replay.trace_id,
      JSON.stringify({ replaced_execution: dl.execution_id, attempt: dl.attempt + 1 }),
    ],
  );

  return {
    kind: 'replayed',
    deadLetterId,
    executionId: replay.id,
    traceId: replay.trace_id,
  };
}

/**
 * Close a dead letter once its replay finished. Called from the callback path,
 * so the outcome is recorded by the same event that produced it.
 */
export async function resolveDeadLetterForReplay(
  tx: Tx,
  replayExecutionId: string,
  succeeded: boolean,
): Promise<number> {
  // Through a security-definer function, not a direct UPDATE. The policy on
  // dead_letters requires a human member, which is right for authorising a
  // replay and wrong for recording how one turned out — that is a machine
  // reporting a fact. The function can only make that one transition, from
  // 'replayed', on the row that named this execution. See migration 0009.
  const row = await tx.one<{ resolve_dead_letter: number }>(
    'select app.resolve_dead_letter($1, $2)',
    [replayExecutionId, succeeded],
  );
  return row?.resolve_dead_letter ?? 0;
}
