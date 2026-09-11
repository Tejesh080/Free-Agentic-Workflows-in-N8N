/**
 * Ingest idempotency, the automation ceiling, the approval state machine, and
 * rubric immutability — the invariants that make a decision reproducible.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';
import { appPrincipal, withTestOrgContext } from './helpers/tx';
import {
  allowedActions,
  dedupeKey,
  effectiveDryRun,
  ingestLead,
  payloadDigest,
} from '../src/lib/leads/ingest';
import { decideApproval, recordApprovalExecution } from '../src/lib/approvals/decide';
import { LeadIngest, RubricDefinition } from '../src/lib/schemas';
import { generateApiKey, hashSecret, parseApiKey } from '../src/lib/auth/api-key';

let db: TestDb;
let f: TwoOrgFixture;

beforeEach(async () => {
  db = await createTestDb();
  f = await seedTwoOrgs(db);
});
afterEach(async () => {
  await db?.close();
});

const lead = (over: Partial<LeadIngest> = {}) =>
  LeadIngest.parse({
    email: 'dana@acme.example',
    first_name: 'Dana',
    company_name: 'Acme Robotics',
    job_title: 'VP Engineering',
    notes: 'We have budget approved and need this live next quarter.',
    ...over,
  });

describe('request schema', () => {
  it('rejects a body that tries to name its own organization', () => {
    expect(LeadIngest.safeParse({ email: 'x@y.example', org_id: f.orgB }).success).toBe(false);
    expect(LeadIngest.safeParse({ email: 'x@y.example', tenant_id: 'org-b' }).success).toBe(false);
  });

  it('rejects unknown fields rather than dropping them', () => {
    // Mass assignment starts with a permissive parser. A caller who sends
    // latest_score should be told no, not have it quietly ignored.
    expect(LeadIngest.safeParse({ email: 'x@y.example', latest_score: 100 }).success).toBe(false);
  });

  it('defaults to a dry run when the caller says nothing', () => {
    expect(lead().dry_run).toBe(true);
  });
});

describe('server-derived keys', () => {
  it('derives the dedupe key from the email, case and whitespace insensitively', () => {
    expect(dedupeKey({ email: ' Dana@Acme.Example ' })).toBe(dedupeKey({ email: 'dana@acme.example' }));
  });

  it('gives different payloads different digests', () => {
    expect(payloadDigest(lead())).not.toBe(payloadDigest(lead({ notes: 'different' })));
  });
});

describe('automation ceiling', () => {
  it('maps each level to the actions it permits', () => {
    expect(allowedActions('dry_run')).toEqual([]);
    expect(allowedActions('crm_write')).toEqual(['crm_write']);
    expect(allowedActions('outreach_draft')).toEqual(['crm_write', 'outreach_draft']);
    expect(allowedActions('outreach_send')).toEqual(['crm_write', 'outreach_draft', 'outreach_send']);
  });

  it('a caller cannot raise the ceiling by asking for a live run', () => {
    expect(effectiveDryRun(false, 'dry_run')).toBe(true);
    expect(effectiveDryRun(false, 'crm_write')).toBe(false);
    // And a caller can always narrow it.
    expect(effectiveDryRun(true, 'outreach_send')).toBe(true);
  });

  it('an organization at dry_run gets no allowed actions even when asked for a live run', async () => {
    const result = await withTestOrgContext(db, appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA }), (tx) =>
      ingestLead(tx, appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA }), lead({ dry_run: false })),
    );
    expect(result.dryRun).toBe(true);
    expect(result.allowed).toEqual([]);
  });

  it('a raised ceiling is honoured', async () => {
    await db.admin(`update organizations set automation_level = 'outreach_draft' where id = $1`, [f.orgA]);
    const result = await withTestOrgContext(db, appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA }), (tx) =>
      ingestLead(tx, appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA }), lead({ dry_run: false })),
    );
    expect(result.dryRun).toBe(false);
    expect(result.allowed).toEqual(['crm_write', 'outreach_draft']);
  });
});

describe('ingest idempotency', () => {
  it('an identical resend converges on one execution', async () => {
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const one = await withTestOrgContext(db, p, (tx) => ingestLead(tx, p, lead()));
    const two = await withTestOrgContext(db, p, (tx) => ingestLead(tx, p, lead()));

    expect(one.replayed).toBe(false);
    expect(two.replayed).toBe(true);
    expect(two.traceId).toBe(one.traceId);
    expect(two.executionId).toBe(one.executionId);

    const count = first(
      await db.admin<{ c: number }>(
        `select count(*)::int as c from executions where org_id = $1 and lead_id = $2`,
        [f.orgA, one.leadId],
      ),
    );
    expect(count.c).toBe(1);
  });

  it('an explicit idempotency key suppresses a duplicate even when the payload changed', async () => {
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const one = await withTestOrgContext(db, p, (tx) =>
      ingestLead(tx, p, lead({ idempotency_key: 'client-request-0001' })),
    );
    const two = await withTestOrgContext(db, p, (tx) =>
      ingestLead(tx, p, lead({ idempotency_key: 'client-request-0001', notes: 'edited' })),
    );
    expect(two.replayed).toBe(true);
    expect(two.executionId).toBe(one.executionId);
  });

  it('the same idempotency key in two organizations does not collide', async () => {
    const pa = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const pb = appPrincipal('api_key', f.orgB, { apiKeyId: f.apiKeyB });
    const a = await withTestOrgContext(db, pa, (tx) =>
      ingestLead(tx, pa, lead({ idempotency_key: 'shared-key' })),
    );
    const b = await withTestOrgContext(db, pb, (tx) =>
      ingestLead(tx, pb, lead({ idempotency_key: 'shared-key' })),
    );
    expect(b.replayed).toBe(false);
    expect(b.executionId).not.toBe(a.executionId);
  });

  it('a genuinely changed payload starts a new run against the same lead', async () => {
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const one = await withTestOrgContext(db, p, (tx) => ingestLead(tx, p, lead()));
    const two = await withTestOrgContext(db, p, (tx) =>
      ingestLead(tx, p, lead({ notes: 'Budget was cut; timeline slipped.' })),
    );
    expect(two.replayed).toBe(false);
    // Same person, second qualification.
    expect(two.leadId).toBe(one.leadId);
    expect(two.executionId).not.toBe(one.executionId);
  });

  it('the execution cites the published rubric version', async () => {
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    const result = await withTestOrgContext(db, p, (tx) => ingestLead(tx, p, lead()));
    expect(result.rubricVersion).toBe('1.2.0');
    expect(result.rubricVersionId).toBe(f.rubricA);
  });

  it('ingest writes an audit event naming the api key that did it', async () => {
    const p = appPrincipal('api_key', f.orgA, { apiKeyId: f.apiKeyA });
    await withTestOrgContext(db, p, (tx) => ingestLead(tx, p, lead()));
    const event = first(
      await db.admin<{ action: string; actor_type: string; actor_api_key_id: string }>(
        `select action, actor_type, actor_api_key_id from audit_events where org_id = $1 order by id desc limit 1`,
        [f.orgA],
      ),
    );
    expect(event).toMatchObject({ action: 'lead.ingested', actor_type: 'api_key' });
    expect(event.actor_api_key_id).toBe(f.apiKeyA);
  });
});

describe('approval state machine', () => {
  async function pendingApproval(org = f.orgA, leadId = f.leadA, execId = f.executionA) {
    return first(
      await db.admin<{ id: string }>(
        `insert into approval_requests (org_id, lead_id, execution_id, action, risk_level, policy_reason, payload, payload_digest)
         values ($1,$2,$3,'outreach_send','HIGH','send is HIGH risk','{"body":"hello"}'::jsonb,'digest-1')
         returning id`,
        [org, leadId, execId],
      ),
    ).id;
  }

  it('a pending request can be approved by a member', async () => {
    const id = await pendingApproval();
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    const outcome = await withTestOrgContext(db, p, (tx) =>
      decideApproval(tx, p, id, 'approved', 'looks fine'),
    );
    expect(outcome.kind).toBe('decided');
  });

  it('a decision is terminal: a second click does not re-authorize', async () => {
    const id = await pendingApproval();
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));
    const second = await withTestOrgContext(db, p, (tx) =>
      decideApproval(tx, p, id, 'approved', undefined),
    );
    expect(second).toMatchObject({ kind: 'already_decided', status: 'approved' });
  });

  it('an approval cannot be flipped to rejected afterwards', async () => {
    const id = await pendingApproval();
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));
    await expect(
      db.admin(`update approval_requests set status = 'rejected' where id = $1`, [id]),
    ).rejects.toThrow(/already approved/i);
  });

  it('an expired request is refused and marked expired on read', async () => {
    const id = await pendingApproval();
    await db.admin(`update approval_requests set expires_at = now() - interval '1 minute' where id = $1`, [id]);
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    const outcome = await withTestOrgContext(db, p, (tx) =>
      decideApproval(tx, p, id, 'approved', undefined),
    );
    expect(outcome.kind).toBe('expired');
    const row = first(
      await db.admin<{ status: string }>(`select status from approval_requests where id = $1`, [id]),
    );
    expect(row.status).toBe('expired');
  });

  it('the frozen payload cannot be swapped after approval', async () => {
    const id = await pendingApproval();
    await expect(
      db.admin(
        `update approval_requests set payload = '{"body":"different"}'::jsonb, payload_digest = 'digest-2' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/frozen at request time/i);
  });

  it('an action can be recorded against an approval exactly once', async () => {
    const id = await pendingApproval();
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'approved', undefined));

    const firstRun = await withTestOrgContext(db, p, (tx) =>
      recordApprovalExecution(tx, id, { sent: true, message_id: 'm-1' }),
    );
    expect(firstRun).toBe(true);

    // A retry of the send must not be able to claim the same authorization.
    const secondRun = await withTestOrgContext(db, p, (tx) =>
      recordApprovalExecution(tx, id, { sent: true, message_id: 'm-2' }),
    );
    expect(secondRun).toBe(false);
  });

  it('an action cannot be recorded against a rejected approval', async () => {
    const id = await pendingApproval();
    const p = appPrincipal('user', f.orgA, { userId: f.memberA });
    await withTestOrgContext(db, p, (tx) => decideApproval(tx, p, id, 'rejected', 'off-policy'));
    const ran = await withTestOrgContext(db, p, (tx) =>
      recordApprovalExecution(tx, id, { sent: true }),
    );
    expect(ran).toBe(false);
  });

  it('a second pending request for the same action cannot be created', async () => {
    await pendingApproval();
    await expect(pendingApproval()).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('rubric versioning', () => {
  it('a published definition is immutable', async () => {
    await expect(
      db.admin(`update rubric_versions set definition = '{"changed":true}'::jsonb where id = $1`, [
        f.rubricA,
      ]),
    ).rejects.toThrow(/published and its definition is immutable/i);
  });

  it('a published version label is immutable', async () => {
    await expect(
      db.admin(`update rubric_versions set version = '9.9.9' where id = $1`, [f.rubricA]),
    ).rejects.toThrow(/version label is immutable/i);
  });

  it('only one version can be published at a time', async () => {
    await expect(
      db.admin(
        `insert into rubric_versions (org_id, version, status, definition) values ($1,'2.0.0','published','{}'::jsonb)`,
        [f.orgA],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rollback works by archiving the incumbent and publishing the prior version', async () => {
    const draft = first(
      await db.admin<{ id: string }>(
        `insert into rubric_versions (org_id, version, status, definition) values ($1,'2.0.0','draft','{}'::jsonb) returning id`,
        [f.orgA],
      ),
    ).id;
    await db.admin(`update rubric_versions set status = 'archived', archived_at = now() where id = $1`, [f.rubricA]);
    await db.admin(`update rubric_versions set status = 'published', published_at = now() where id = $1`, [draft]);

    const published = first(
      await db.admin<{ version: string }>(
        `select version from rubric_versions where org_id = $1 and status = 'published'`,
        [f.orgA],
      ),
    );
    expect(published.version).toBe('2.0.0');
  });

  it('an archived version cannot be resurrected', async () => {
    await db.admin(`update rubric_versions set status = 'archived', archived_at = now() where id = $1`, [f.rubricA]);
    await expect(
      db.admin(`update rubric_versions set status = 'published' where id = $1`, [f.rubricA]),
    ).rejects.toThrow(/archived/i);
  });

  it('a rubric that a decision cites cannot be deleted', async () => {
    await db.admin(
      `insert into decision_receipts (org_id, lead_id, execution_id, trace_id, decision, rubric_version_id)
       values ($1,$2,$3,'trc_a1','qualified',$4)`,
      [f.orgA, f.leadA, f.executionA, f.rubricA],
    );
    await expect(
      db.admin(`delete from rubric_versions where id = $1`, [f.rubricA]),
    ).rejects.toThrow(/violates foreign key/i);
  });

  it('the rubric definition schema takes weights and thresholds but never logic', () => {
    const valid = RubricDefinition.safeParse({
      signals: [
        {
          key: 'budget',
          question: 'Is there a budget?',
          values: [
            { value: 'approved', points: 25 },
            { value: 'none', points: 0 },
          ],
          unsupported_penalty: -10,
        },
      ],
      thresholds: { HOT: 70, WARM: 45 },
    });
    expect(valid.success).toBe(true);

    // No field accepts an expression, a script, or a URL to fetch one.
    const hostile = RubricDefinition.safeParse({
      signals: [
        {
          key: 'budget',
          question: 'x',
          values: [
            { value: 'a', points: 1 },
            { value: 'b', points: 2 },
          ],
          compute: 'process.exit(1)',
        },
      ],
      thresholds: { HOT: 70, WARM: 45 },
    });
    expect(hostile.success).toBe(false);
  });
});

describe('api key format', () => {
  it('round-trips a generated key', () => {
    const key = generateApiKey('live');
    const parsed = parseApiKey(key.token);
    expect(parsed).toBeDefined();
    expect(parsed!.prefix).toBe(key.prefix);
    expect(hashSecret(parsed!.secret)).toBe(key.secretHash);
  });

  it('never stores the token itself', () => {
    const key = generateApiKey('test');
    expect(key.secretHash).not.toContain(key.token);
    expect(key.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed credentials before they reach the database', () => {
    for (const bad of [
      '',
      'rsk_live',
      'Bearer rsk_live_aaaa_bbbb',
      'rsk_prod_aaaaaaaaaaaa_' + 'b'.repeat(43),
      'rsk_live_short_' + 'b'.repeat(43),
      // Right length, wrong alphabet: the prefix must be hex.
      'rsk_live_zzzzzzzzzzzzzzzz_' + 'b'.repeat(43),
      'rsk_live_aaaaaaaaaaaa_tooshort',
      "rsk_live_aaaaaaaaaaaa_'; drop table leads; --",
    ]) {
      expect(parseApiKey(bad)).toBeUndefined();
    }
  });
});
