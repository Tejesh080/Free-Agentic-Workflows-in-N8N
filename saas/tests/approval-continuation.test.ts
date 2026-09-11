/**
 * Approval continuation.
 *
 * The invariant under test is that approval and execution stay two separate,
 * separately auditable facts — not that a message gets sent. No outbound
 * channel is configured, so the action is simulated and says so; what must hold
 * either way is that a human's yes is recorded once, the action runs at most
 * once, and a rejection runs nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';
import { appPrincipal, withTestOrgContext } from './helpers/tx';
import { decideApproval } from '../src/lib/approvals/decide';
import { executeApprovedAction, outboundChannelConfigured } from '../src/lib/approvals/execute';

let db: TestDb;
let f: TwoOrgFixture;

beforeEach(async () => {
  db = await createTestDb();
  f = await seedTwoOrgs(db);
});
afterEach(async () => {
  await db?.close();
});

const human = () => appPrincipal('user', f.orgA, { userId: f.memberA });

async function pending() {
  return first(
    await db.admin<{ id: string }>(
      `insert into approval_requests (org_id, lead_id, execution_id, action, risk_level, policy_reason, payload, payload_digest)
       values ($1,$2,$3,'outreach_send','HIGH','send is HIGH risk','{"subject":"Hi","body":"Hello"}'::jsonb,'d1')
       returning id`,
      [f.orgA, f.leadA, f.executionA],
    ),
  ).id;
}

describe('approval then execution', () => {
  it('records the decision and the execution as separate facts', async () => {
    const id = await pending();
    const p = human();

    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', 'looks right'));
    const afterDecision = first(
      await db.admin<{ status: string; decided_at: Date | null; executed_at: Date | null }>(
        `select status::text as status, decided_at, executed_at from approval_requests where id = $1`,
        [id],
      ),
    );
    // Decided, and explicitly NOT yet executed.
    expect(afterDecision.status).toBe('approved');
    expect(afterDecision.decided_at).not.toBeNull();
    expect(afterDecision.executed_at).toBeNull();

    const outcome = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    expect(outcome.kind).toBe('executed');

    const afterExecution = first(
      await db.admin<{ decided_at: Date; executed_at: Date; execution_result: Record<string, unknown> }>(
        `select decided_at, executed_at, execution_result from approval_requests where id = $1`,
        [id],
      ),
    );
    expect(afterExecution.executed_at).not.toBeNull();
    // Two distinct timestamps, so "authorised at" and "happened at" are both answerable.
    expect(new Date(afterExecution.executed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(afterExecution.decided_at).getTime(),
    );
  });

  it('says the action was simulated rather than claiming it was sent', async () => {
    expect(outboundChannelConfigured()).toBe(false);
    const id = await pending();
    const p = human();
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));
    const outcome = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));

    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.simulated).toBe(true);
    expect(String(outcome.result['reason'])).toMatch(/no outbound channel/i);
  });

  it('runs the action exactly once however many times it is asked', async () => {
    const id = await pending();
    const p = human();
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));

    const first1 = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    const second = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    const third = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));

    expect(first1.kind).toBe('executed');
    expect(second.kind).toBe('already_executed');
    expect(third.kind).toBe('already_executed');

    const events = first(
      await db.admin<{ n: number }>(
        `select count(*)::int as n from audit_events
          where org_id = $1 and action = 'approval.action_executed'`,
        [f.orgA],
      ),
    );
    expect(events.n).toBe(1);
  });

  it('a rejection executes nothing', async () => {
    const id = await pending();
    const p = human();
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'rejected', 'off-policy'));

    const outcome = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    expect(outcome).toMatchObject({ kind: 'not_approved', status: 'rejected' });

    const row = first(
      await db.admin<{ executed_at: Date | null }>(
        `select executed_at from approval_requests where id = $1`, [id],
      ),
    );
    expect(row.executed_at).toBeNull();
  });

  it('a pending approval cannot be executed', async () => {
    const id = await pending();
    const p = human();
    const outcome = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    expect(outcome).toMatchObject({ kind: 'not_approved', status: 'pending' });
  });

  it('the action runs against the payload frozen at request time', async () => {
    const id = await pending();
    // The database refuses any change to it, so the human approves what runs.
    await expect(
      db.admin(
        `update approval_requests set payload = '{"body":"something else"}'::jsonb, payload_digest = 'd2' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/frozen at request time/i);

    const p = human();
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));
    const outcome = await withTestOrgContext(db, p, (tx) => executeApprovedAction(tx, p, id));
    if (outcome.kind !== 'executed') throw new Error('expected execution');
    expect(outcome.result['payload_keys']).toEqual(['body', 'subject']);
  });

  it("another organization cannot execute an approval", async () => {
    const id = await pending();
    const p = human();
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));

    const other = appPrincipal('user', f.orgB, { userId: f.userB });
    const outcome = await withTestOrgContext(db, other, (tx) => executeApprovedAction(tx, other, id));
    expect(outcome.kind).toBe('not_found');

    const row = first(
      await db.admin<{ executed_at: Date | null }>(
        `select executed_at from approval_requests where id = $1`, [id],
      ),
    );
    expect(row.executed_at).toBeNull();
  });
});
