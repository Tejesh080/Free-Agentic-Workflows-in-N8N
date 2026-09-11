/**
 * The dead-letter queue: preserve what failed, link what was done about it.
 *
 * The property under test is not "a row is written". It is that the failure
 * record survives everything that happens afterwards — a replay does not edit
 * it, a second attempt does not overwrite it, and the chain from original to
 * replay to outcome stays navigable.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';
import { appPrincipal, withTestOrgContext } from './helpers/tx';
import {
  recordDeadLetter,
  replayDeadLetter,
  resolveDeadLetterForReplay,
} from '../src/lib/executions/dead-letter';

let db: TestDb;
let f: TwoOrgFixture;

beforeEach(async () => {
  db = await createTestDb();
  f = await seedTwoOrgs(db);
});
afterEach(async () => {
  await db?.close();
});

const systemA = () => appPrincipal('system', f.orgA);
const humanA = () => appPrincipal('user', f.orgA, { userId: f.memberA });

const record = (over: Partial<Parameters<typeof recordDeadLetter>[2]> = {}) =>
  withTestOrgContext(db, systemA(), (tx) =>
    recordDeadLetter(tx, systemA(), {
      executionId: f.executionA,
      leadId: f.leadA,
      traceId: 'trc_a1',
      stage: 'engine',
      error: { message: 'the engine fell over', code: 'NODE_CRASH' },
      failingNode: 'HubSpot Upsert Contact',
      ...over,
    }),
  );

describe('recording a failure', () => {
  it('writes the failure and marks the execution dead-lettered', async () => {
    const id = await record();
    expect(id).toBeTruthy();

    const dl = first(
      await db.admin<{ stage: string; status: string; failing_node: string; error: Record<string, unknown> }>(
        `select stage::text as stage, status::text as status, failing_node, error
           from dead_letters where execution_id = $1`,
        [f.executionA],
      ),
    );
    expect(dl).toMatchObject({ stage: 'engine', status: 'open', failing_node: 'HubSpot Upsert Contact' });
    // The error is kept as the engine gave it, not flattened to a string.
    expect(dl.error).toMatchObject({ code: 'NODE_CRASH' });

    const exec = first(
      await db.admin<{ status: string }>(
        `select status::text as status from executions where id = $1`, [f.executionA],
      ),
    );
    expect(exec.status).toBe('dead_letter');
  });

  it('is idempotent for the same execution', async () => {
    await record();
    const second = await record({ error: { message: 'reported again' } });
    expect(second).toBeUndefined();

    const count = first(
      await db.admin<{ n: number }>(
        `select count(*)::int as n from dead_letters where execution_id = $1`, [f.executionA],
      ),
    );
    expect(count.n).toBe(1);
    // And the FIRST error is the one kept.
    const dl = first(
      await db.admin<{ error: Record<string, unknown> }>(
        `select error from dead_letters where execution_id = $1`, [f.executionA],
      ),
    );
    expect(dl.error).toMatchObject({ code: 'NODE_CRASH' });
  });

  it('writes an audit event', async () => {
    await record();
    const e = first(
      await db.admin<{ action: string }>(
        `select action from audit_events where org_id = $1 order by id desc limit 1`, [f.orgA],
      ),
    );
    expect(e.action).toBe('execution.dead_lettered');
  });
});

describe('the failure record is immutable', () => {
  it('refuses to change what failed', async () => {
    await record();
    for (const sql of [
      `update dead_letters set error = '{"message":"rewritten"}'::jsonb where execution_id = $1`,
      `update dead_letters set stage = 'dispatch' where execution_id = $1`,
      `update dead_letters set failing_node = 'somewhere else' where execution_id = $1`,
      `update dead_letters set trace_id = 'trc_rewritten' where execution_id = $1`,
    ]) {
      await expect(db.admin(sql, [f.executionA])).rejects.toThrow(/immutable/i);
    }
  });

  it('allows the resolution fields to change', async () => {
    await record();
    await expect(
      db.admin(
        `update dead_letters set status = 'abandoned', resolution = 'not worth retrying' where execution_id = $1`,
        [f.executionA],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to mark replayed without naming the replay execution', async () => {
    await record();
    await expect(
      db.admin(`update dead_letters set status = 'replayed' where execution_id = $1`, [f.executionA]),
    ).rejects.toThrow(/without a replay execution/i);
  });
});

describe('replay', () => {
  it('creates a new execution and links it both ways', async () => {
    const dlId = (await record())!;
    const outcome = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind !== 'replayed') return;

    // Forward: dead letter -> replay execution.
    const dl = first(
      await db.admin<{ status: string; replay_execution_id: string; replayed_by: string }>(
        `select status::text as status, replay_execution_id, replayed_by from dead_letters where id = $1`,
        [dlId],
      ),
    );
    expect(dl.status).toBe('replayed');
    expect(dl.replay_execution_id).toBe(outcome.executionId);
    expect(dl.replayed_by).toBe(f.memberA);

    // Backward: replay execution -> the execution it replaces.
    const replay = first(
      await db.admin<{ replay_of: string; attempt: number; status: string }>(
        `select replay_of, attempt, status::text as status from executions where id = $1`,
        [outcome.executionId],
      ),
    );
    expect(replay.replay_of).toBe(f.executionA);
    expect(replay.attempt).toBe(2);
    expect(replay.status).toBe('queued');
  });

  it('does not touch the original execution or its failure', async () => {
    const dlId = (await record())!;
    const before = first(
      await db.admin<{ status: string; error: unknown }>(
        `select e.status::text as status, d.error from executions e
           join dead_letters d on d.execution_id = e.id where e.id = $1`,
        [f.executionA],
      ),
    );
    await withTestOrgContext(db, humanA(), (tx) => replayDeadLetter(tx, humanA(), dlId));
    const after = first(
      await db.admin<{ status: string; error: unknown }>(
        `select e.status::text as status, d.error from executions e
           join dead_letters d on d.execution_id = e.id where e.id = $1`,
        [f.executionA],
      ),
    );
    expect(after).toEqual(before);
  });

  it('cannot be replayed twice', async () => {
    const dlId = (await record())!;
    await withTestOrgContext(db, humanA(), (tx) => replayDeadLetter(tx, humanA(), dlId));
    const second = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    expect(second).toMatchObject({ kind: 'already_replayed', status: 'replayed' });
  });

  it('a machine principal cannot authorise a replay', async () => {
    const dlId = (await record())!;
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const outcome = await withTestOrgContext(db, p, (tx) => replayDeadLetter(tx, p, dlId));
    // The policy refuses the update, so the replay cannot be recorded.
    expect(outcome.kind).toBe('not_found');
    const dl = first(
      await db.admin<{ status: string }>(
        `select status::text as status from dead_letters where id = $1`, [dlId],
      ),
    );
    expect(dl.status).toBe('open');
  });

  it("another organization cannot see or replay a dead letter", async () => {
    const dlId = (await record())!;
    const rows = await db.as(
      { kind: 'user', userId: f.userB, orgId: f.orgB },
      `select id from dead_letters where id = $1`,
      [dlId],
    );
    expect(rows).toEqual([]);
  });

  it('the replay keeps a distinct idempotency key so it is not suppressed', async () => {
    const dlId = (await record())!;
    const outcome = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    if (outcome.kind !== 'replayed') throw new Error('expected a replay');
    const keys = await db.admin<{ idempotency_key: string }>(
      `select idempotency_key from executions where id = any($1::uuid[]) order by attempt`,
      [[f.executionA, outcome.executionId]],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]!.idempotency_key).not.toBe(keys[1]!.idempotency_key);
  });
});

describe('resolution', () => {
  it('a successful replay marks the dead letter recovered', async () => {
    const dlId = (await record())!;
    const outcome = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    if (outcome.kind !== 'replayed') throw new Error('expected a replay');

    await withTestOrgContext(db, systemA(), (tx) =>
      resolveDeadLetterForReplay(tx, outcome.executionId, true),
    );
    const dl = first(
      await db.admin<{ status: string; resolved_at: Date | null; resolution: string }>(
        `select status::text as status, resolved_at, resolution from dead_letters where id = $1`,
        [dlId],
      ),
    );
    expect(dl.status).toBe('recovered');
    expect(dl.resolved_at).not.toBeNull();
  });

  it('a failed replay reopens the dead letter rather than closing it', async () => {
    const dlId = (await record())!;
    const outcome = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    if (outcome.kind !== 'replayed') throw new Error('expected a replay');

    await withTestOrgContext(db, systemA(), (tx) =>
      resolveDeadLetterForReplay(tx, outcome.executionId, false),
    );
    const dl = first(
      await db.admin<{ status: string; resolution: string }>(
        `select status::text as status, resolution from dead_letters where id = $1`, [dlId],
      ),
    );
    expect(dl.status).toBe('open');
    expect(dl.resolution).toMatch(/also failed/i);
  });

  it('the timeline view joins original, replay and outcome in one row', async () => {
    const dlId = (await record())!;
    const outcome = await withTestOrgContext(db, humanA(), (tx) =>
      replayDeadLetter(tx, humanA(), dlId),
    );
    if (outcome.kind !== 'replayed') throw new Error('expected a replay');

    const row = first(
      await db.as<{
        original_trace_id: string; replay_trace_id: string; lead_email: string; status: string;
      }>(
        { kind: 'user', userId: f.memberA, orgId: f.orgA },
        `select original_trace_id, replay_trace_id, lead_email, status::text as status
           from dead_letter_timeline where dead_letter_id = $1`,
        [dlId],
      ),
    );
    expect(row.original_trace_id).toBe('trc_a1');
    expect(row.replay_trace_id).toBe(outcome.traceId);
    expect(row.lead_email).toBe('a1@example.test');
    expect(row.status).toBe('replayed');
  });

  it('the timeline view is subject to row level security', async () => {
    const dlId = (await record())!;
    const rows = await db.as(
      { kind: 'user', userId: f.userB, orgId: f.orgB },
      `select dead_letter_id from dead_letter_timeline where dead_letter_id = $1`,
      [dlId],
    );
    expect(rows).toEqual([]);
  });
});
