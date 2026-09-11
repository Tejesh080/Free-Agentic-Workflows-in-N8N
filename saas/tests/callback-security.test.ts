/**
 * Adversarial tests for the engine -> SaaS callback.
 *
 * The callback is the one place an outside party can write to a decision
 * record, so each of these is a specific attack, not a smoke test.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';
import { appPrincipal, withTestOrgContext } from './helpers/tx';
import { bodyDigest, canonicalString, signRequest, verifyRequest } from '../src/lib/hmac';
import { applyCompletion, type CallbackTarget } from '../src/lib/executions/complete';
import { CallbackPayload } from '../src/lib/schemas';

const SECRET = 'callback-secret-for-tests-only';
const PATH = '/api/internal/executions/trc_a1/complete';

function headersOf(record: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const samplePayload = () =>
  CallbackPayload.parse({
    status: 'succeeded',
    decision: 'qualified',
    score: 87,
    tier: 'HOT',
    rubric_version: '1.2.0',
    prompt_versions: { 'revenue/lead-qualifier': 'a1b2c3d' },
    model_metadata: { provider: 'openai', model: 'gpt-5-mini' },
    score_components: [{ signal: 'budget', value: 'approved', points: 25, supported: true }],
    evidence: [
      {
        signal: 'budget',
        value: 'approved',
        quote: 'the budget is approved for this quarter',
        source_field: 'notes',
        supported: true,
        points: 25,
      },
    ],
    verification: { supported: 1, total: 1 },
    governance: { risk_level: 'LOW', decision: 'allow' },
    actions_taken: [{ action: 'crm_upsert_contact', object_id: 'sim-contact-1' }],
    actions_skipped: [{ action: 'outreach_send', reason: 'organization automation level is dry_run' }],
    started_at: '2026-09-12T00:00:00.000Z',
    completed_at: '2026-09-12T00:00:12.000Z',
  });

describe('signature verification', () => {
  it('accepts a correctly signed request', () => {
    const body = JSON.stringify(samplePayload());
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body });
    const result = verifyRequest({
      secret: SECRET,
      method: 'POST',
      path: PATH,
      body,
      headers: headersOf(signed),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const body = JSON.stringify(samplePayload());
    const signed = signRequest({ secret: 'some-other-secret', method: 'POST', path: PATH, body });
    const result = verifyRequest({ secret: SECRET, method: 'POST', path: PATH, body, headers: headersOf(signed) });
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a body mutated after signing', () => {
    const body = JSON.stringify(samplePayload());
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body });
    // The classic tamper: keep the signature, raise the score.
    const tampered = body.replace('"score":87', '"score":100');
    expect(tampered).not.toBe(body);
    const result = verifyRequest({ secret: SECRET, method: 'POST', path: PATH, body: tampered, headers: headersOf(signed) });
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature captured from a different endpoint', () => {
    const body = JSON.stringify(samplePayload());
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body });
    const result = verifyRequest({
      secret: SECRET,
      method: 'POST',
      // Same body, same secret, different execution.
      path: '/api/internal/executions/trc_b1/complete',
      body,
      headers: headersOf(signed),
    });
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp', () => {
    const body = JSON.stringify(samplePayload());
    const now = Math.floor(Date.now() / 1000);
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body, timestamp: now - 3600 });
    const result = verifyRequest({ secret: SECRET, method: 'POST', path: PATH, body, headers: headersOf(signed), now });
    expect(result).toMatchObject({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a timestamp far in the future', () => {
    const body = JSON.stringify(samplePayload());
    const now = Math.floor(Date.now() / 1000);
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body, timestamp: now + 3600 });
    const result = verifyRequest({ secret: SECRET, method: 'POST', path: PATH, body, headers: headersOf(signed), now });
    expect(result).toMatchObject({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects missing signature headers', () => {
    const result = verifyRequest({ secret: SECRET, method: 'POST', path: PATH, body: '{}', headers: headersOf({}) });
    expect(result).toMatchObject({ ok: false, reason: 'missing_headers' });
  });

  it('fails closed when no secret is configured', () => {
    const body = JSON.stringify(samplePayload());
    const signed = signRequest({ secret: SECRET, method: 'POST', path: PATH, body });
    const result = verifyRequest({ secret: undefined, method: 'POST', path: PATH, body, headers: headersOf(signed) });
    // Not "allowed because unconfigured".
    expect(result).toMatchObject({ ok: false, reason: 'no_secret' });
  });

  it('binds the digest to raw bytes, not to a parsed object', () => {
    const a = '{"status":"succeeded","decision":"qualified"}';
    const b = '{"decision":"qualified","status":"succeeded"}';
    // Semantically identical JSON, different bytes. Re-serialising a signed body
    // must not preserve the signature, or a proxy could rewrite it freely.
    expect(bodyDigest(a)).not.toBe(bodyDigest(b));
  });

  it('pins the canonical string format', () => {
    expect(
      canonicalString({ method: 'post', path: '/x', timestamp: '1', nonce: 'n', digest: 'd' }),
    ).toBe('v1:POST:/x:1:n:d');
  });
});

describe('callback payload schema', () => {
  it('rejects a callback that tries to name its own organization', () => {
    const parsed = CallbackPayload.safeParse({
      status: 'succeeded',
      decision: 'qualified',
      org_id: '00000000-0000-0000-0000-0000000000bb',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a callback that tries to name a different lead', () => {
    const parsed = CallbackPayload.safeParse({
      status: 'succeeded',
      decision: 'qualified',
      lead_id: 'lead_somebody_else',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a reason for every skipped action', () => {
    const parsed = CallbackPayload.safeParse({
      status: 'succeeded',
      decision: 'qualified',
      actions_skipped: [{ action: 'outreach_send' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('completion application', () => {
  let db: TestDb;
  let f: TwoOrgFixture;

  beforeEach(async () => {
    db = await createTestDb();
    f = await seedTwoOrgs(db);
  });
  afterEach(async () => {
    await db?.close();
  });

  const targetA = (): CallbackTarget => ({
    executionId: f.executionA,
    orgId: f.orgA,
    leadId: f.leadA,
    status: 'dispatched',
    completedAt: null,
    dryRun: true,
  });

  it('records the receipt, evidence and audit entry', async () => {
    const outcome = await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), samplePayload(), {
        nonce: 'n-1',
        signedAt: new Date(),
        bodyDigest: 'bd-1',
      }),
    );
    expect(outcome.kind).toBe('applied');

    const receipt = first(
      await db.admin<{ tier: string; score: number; actions_skipped: unknown }>(
        `select tier, score, actions_skipped from decision_receipts where execution_id = $1`,
        [f.executionA],
      ),
    );
    expect(receipt.tier).toBe('HOT');
    expect(receipt.score).toBe(87);

    const evidence = await db.admin<{ c: number }>(
      `select count(*)::int as c from lead_evidence where execution_id = $1`,
      [f.executionA],
    );
    expect(first(evidence).c).toBe(1);

    const lead = first(
      await db.admin<{ latest_tier: string; status: string }>(
        `select latest_tier, status from leads where id = $1`,
        [f.leadA],
      ),
    );
    expect(lead).toMatchObject({ latest_tier: 'HOT', status: 'qualified' });
  });

  it('refuses a replayed nonce', async () => {
    const delivery = { nonce: 'n-replay', signedAt: new Date(), bodyDigest: 'bd' };
    await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), samplePayload(), delivery),
    );
    const second = await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), samplePayload(), delivery),
    );
    expect(second.kind).toBe('replayed');
  });

  it('a second completion with a fresh nonce cannot overwrite a finished decision', async () => {
    await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), samplePayload(), {
        nonce: 'n-first',
        signedAt: new Date(),
        bodyDigest: 'bd',
      }),
    );

    // The engine retried and now claims a different, better answer.
    const rogue = CallbackPayload.parse({
      ...samplePayload(),
      score: 100,
      tier: 'HOT',
      decision: 'overwritten',
    });
    const outcome = await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(
        tx,
        { ...targetA(), status: 'succeeded', completedAt: new Date() },
        rogue,
        { nonce: 'n-second', signedAt: new Date(), bodyDigest: 'bd2' },
      ),
    );
    expect(outcome.kind).toBe('already_complete');

    const receipt = first(
      await db.admin<{ score: number; decision: string; c: number }>(
        `select score, decision from decision_receipts where execution_id = $1`,
        [f.executionA],
      ),
    );
    expect(receipt.score).toBe(87);
    expect(receipt.decision).toBe('qualified');

    const count = first(
      await db.admin<{ c: number }>(
        `select count(*)::int as c from decision_receipts where execution_id = $1`,
        [f.executionA],
      ),
    );
    expect(count.c).toBe(1);
  });

  it('creates an approval request when governance held the action', async () => {
    const payload = CallbackPayload.parse({
      ...samplePayload(),
      approval: {
        required: true,
        action: 'outreach_send',
        risk_level: 'HIGH',
        policy_reason: 'action_type send is HIGH risk; a human approves every real send',
        payload: { subject: 'Following up', body: 'Hello there' },
      },
    });
    const outcome = await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), payload, {
        nonce: 'n-approval',
        signedAt: new Date(),
        bodyDigest: 'bd',
      }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.approvalId).toBeTruthy();

    const approval = first(
      await db.admin<{ status: string; risk_level: string }>(
        `select status, risk_level from approval_requests where execution_id = $1`,
        [f.executionA],
      ),
    );
    expect(approval).toMatchObject({ status: 'pending', risk_level: 'HIGH' });
  });

  it('a receipt cannot be edited afterwards — two independent layers', async () => {
    await withTestOrgContext(db, appPrincipal('system', f.orgA), (tx) =>
      applyCompletion(tx, targetA(), samplePayload(), {
        nonce: 'n-immutable',
        signedAt: new Date(),
        bodyDigest: 'bd',
      }),
    );

    // Layer 1 — policy. decision_receipts has no UPDATE policy at all, so the
    // statement matches nothing rather than raising. Assert the effect, not the
    // error: silently affecting zero rows is the correct outcome here.
    const updated = await db.as(
      { kind: 'user', userId: f.userA, orgId: f.orgA },
      `update decision_receipts set score = 100 where execution_id = $1 returning id`,
      [f.executionA],
    );
    expect(updated).toEqual([]);
    expect(
      first(
        await db.admin<{ score: number }>(
          `select score from decision_receipts where execution_id = $1`,
          [f.executionA],
        ),
      ).score,
    ).toBe(87);

    // Layer 2 — trigger. With RLS out of the picture (owner connection) the
    // append-only trigger still refuses, so a future migration that mistakenly
    // adds an UPDATE policy would not silently make history editable.
    await expect(
      db.admin(`update decision_receipts set score = 100 where execution_id = $1`, [f.executionA]),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db.admin(`delete from decision_receipts where execution_id = $1`, [f.executionA]),
    ).rejects.toThrow(/append-only/i);
  });
});
