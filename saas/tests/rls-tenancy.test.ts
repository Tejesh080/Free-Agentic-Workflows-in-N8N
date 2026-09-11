/**
 * Adversarial multi-tenancy tests.
 *
 * Every assertion here runs against the real policies in supabase/migrations,
 * as the real non-owning application role. Nothing is stubbed. If this file is
 * green, the sentence "tenant isolation is enforced by the database" is
 * supported by evidence; if it is not, the sentence may not be written.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';

let db: TestDb;
let f: TwoOrgFixture;

beforeEach(async () => {
  db = await createTestDb();
  f = await seedTwoOrgs(db);
});
afterEach(async () => {
  await db?.close();
});

describe('read isolation', () => {
  it("an API key for org A cannot read org B's leads", async () => {
    const rows = await db.as({ kind: 'api_key', orgId: f.orgA }, `select id, org_id from leads`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(f.orgA);
  });

  it("a user in org A cannot read org B's leads even by explicit id", async () => {
    const rows = await db.as(
      { kind: 'user', userId: f.userA, orgId: f.orgA },
      `select id from leads where id = $1`,
      [f.leadB],
    );
    expect(rows).toEqual([]);
  });

  it('an object in another organization is indistinguishable from one that does not exist', async () => {
    const principal = { kind: 'user', userId: f.userA, orgId: f.orgA } as const;
    const otherOrg = await db.as(principal, `select id from leads where id = $1`, [f.leadB]);
    const nonexistent = await db.as(principal, `select id from leads where id = gen_random_uuid()`);
    // Same shape, same emptiness: the API layer turns both into 404, so a probe
    // cannot confirm that another organization's object exists.
    expect(otherOrg).toEqual(nonexistent);
  });

  it('isolation holds for every tenant-owned table, not just leads', async () => {
    // Give org B a row in each table so "empty" cannot pass by accident.
    await db.admin(
      `insert into lead_evidence (org_id, lead_id, execution_id, signal, value, quote, supported)
       values ($1,$2,$3,'budget','approved','we have signed off the budget',true)`,
      [f.orgB, f.leadB, f.executionB],
    );
    await db.admin(
      `insert into decision_receipts (org_id, lead_id, execution_id, trace_id, decision, score, tier)
       values ($1,$2,$3,'trc_b1','qualified',88,'HOT')`,
      [f.orgB, f.leadB, f.executionB],
    );
    await db.admin(
      `insert into approval_requests (org_id, lead_id, execution_id, action, policy_reason, payload_digest)
       values ($1,$2,$3,'outreach_send','send is HIGH risk by default','d1')`,
      [f.orgB, f.leadB, f.executionB],
    );
    await db.admin(
      `insert into lead_outcomes (org_id, lead_id, state) values ($1,$2,'replied')`,
      [f.orgB, f.leadB],
    );
    await db.admin(
      `insert into audit_events (org_id, actor_type, action, target_type, target_id)
       values ($1,'user','rubric.publish','rubric_version','x')`,
      [f.orgB],
    );
    await db.admin(
      `insert into integrations (org_id, provider, status) values ($1,'hubspot','connected')`,
      [f.orgB],
    );
    await db.admin(
      `insert into callback_deliveries (org_id, execution_id, nonce, signed_at, body_digest)
       values ($1,$2,'nonce-b','2026-09-12T00:00:00Z','bd')`,
      [f.orgB, f.executionB],
    );

    const tables = [
      'leads',
      'executions',
      'lead_evidence',
      'decision_receipts',
      'approval_requests',
      'lead_outcomes',
      'audit_events',
      'integrations',
      'callback_deliveries',
      'rubric_versions',
      'evaluation_runs',
    ];
    const leaked: string[] = [];
    for (const t of tables) {
      const rows = await db.as<{ c: number }>(
        { kind: 'api_key', orgId: f.orgA },
        `select count(*)::int as c from ${t} where org_id = $1`,
        [f.orgB],
      );
      if (rows[0]!.c !== 0) leaked.push(t);
    }
    expect(leaked).toEqual([]);
  });
});

describe('write isolation', () => {
  it("org A cannot update org B's lead", async () => {
    const rows = await db.as(
      { kind: 'api_key', orgId: f.orgA },
      `update leads set company_name = 'pwned' where id = $1 returning id`,
      [f.leadB],
    );
    expect(rows).toEqual([]);
    const [check] = await db.admin<{ company_name: string }>(
      `select company_name from leads where id = $1`,
      [f.leadB],
    );
    expect(check!.company_name).toBe('Acme Test');
  });

  it("org A cannot delete org B's lead", async () => {
    const rows = await db.as(
      { kind: 'user', userId: f.userA, orgId: f.orgA },
      `delete from leads where id = $1 returning id`,
      [f.leadB],
    );
    expect(rows).toEqual([]);
    const [check] = await db.admin<{ c: number }>(
      `select count(*)::int as c from leads where id = $1`,
      [f.leadB],
    );
    expect(check!.c).toBe(1);
  });

  it('org A cannot insert a row that claims to belong to org B', async () => {
    await expect(
      db.as(
        { kind: 'api_key', orgId: f.orgA },
        `insert into leads (org_id, public_id, dedupe_key, email)
         values ($1, 'smuggled', 'dk-smuggled', 'x@example.test')`,
        [f.orgB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('org A cannot move a row it owns into org B by update', async () => {
    await expect(
      db.as(
        { kind: 'api_key', orgId: f.orgA },
        `update leads set org_id = $1 where id = $2`,
        [f.orgB, f.leadA],
      ),
    ).rejects.toThrow(/row-level security/i);

    const [check] = await db.admin<{ org_id: string }>(`select org_id from leads where id = $1`, [
      f.leadA,
    ]);
    expect(check!.org_id).toBe(f.orgA);
  });

  it('a delete that is allowed within the organization still works (the policy is not just off)', async () => {
    const rows = await db.as(
      { kind: 'user', userId: f.userA, orgId: f.orgA },
      `delete from leads where id = $1 returning id`,
      [f.leadA],
    );
    expect(rows).toHaveLength(1);
  });

  it('a non-admin member cannot delete a lead even in their own organization', async () => {
    const rows = await db.as(
      { kind: 'user', userId: f.memberA, orgId: f.orgA },
      `delete from leads where id = $1 returning id`,
      [f.leadA],
    );
    expect(rows).toEqual([]);
  });
});

describe('absent and forged context', () => {
  it('a session with no organization context reads no tenant rows', async () => {
    const rows = await db.as({ kind: 'anonymous' }, `select id from leads`);
    expect(rows).toEqual([]);
  });

  it('a session with no context cannot insert either', async () => {
    await expect(
      db.as(
        { kind: 'anonymous' },
        `insert into leads (org_id, public_id, dedupe_key) values ($1,'nc','dk-nc')`,
        [f.orgA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a user id with no membership in the named organization gets nothing', async () => {
    // userB is a real, valid, signed-in user — just not a member of org A.
    const rows = await db.as(
      { kind: 'user', userId: f.userB, orgId: undefined },
      `select id from leads where org_id = $1`,
      [f.orgA],
    );
    expect(rows).toEqual([]);
  });

  it('a malformed organization context is treated as absent, not as a wildcard', async () => {
    // app.current_org_id() swallows the cast failure and returns null. The
    // failure mode of a bad context must be "no access", never "all access".
    const rows = await db.asRawContext('not-a-uuid', '', 'select id from leads');
    expect(rows).toEqual([]);
  });
});

describe('api key storage', () => {
  it('the application role cannot read a key hash at all', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash) values ($1,'k','rsk_live_aaaa','deadbeef')`,
      [f.orgA],
    );
    // Not "returns no rows" — the column privilege is absent, so the query is
    // rejected before RLS is even consulted.
    await expect(
      db.as({ kind: 'user', userId: f.userA, orgId: f.orgA }, `select secret_hash from api_keys`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a non-admin member cannot list keys', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash) values ($1,'k','rsk_live_bbbb','h')`,
      [f.orgA],
    );
    const rows = await db.as(
      { kind: 'user', userId: f.memberA, orgId: f.orgA },
      `select id from api_keys`,
    );
    expect(rows).toEqual([]);
  });

  it('a machine principal cannot enumerate keys, including its own', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash) values ($1,'k','rsk_live_cccc','h')`,
      [f.orgA],
    );
    const rows = await db.as({ kind: 'api_key', orgId: f.orgA }, `select id, prefix from api_keys`);
    expect(rows).toEqual([]);
  });

  it('authenticate_api_key resolves a valid key to its own organization only', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash) values ($1,'k','rsk_live_dddd','hash-d')`,
      [f.orgB],
    );
    const rows = await db.as<{ org_id: string }>(
      { kind: 'anonymous' },
      `select org_id from app.authenticate_api_key($1, $2)`,
      ['rsk_live_dddd', 'hash-d'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(f.orgB);
  });

  it('a revoked key authenticates to nothing', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash, revoked_at)
       values ($1,'k','rsk_live_eeee','hash-e', now())`,
      [f.orgA],
    );
    const rows = await db.as(
      { kind: 'anonymous' },
      `select org_id from app.authenticate_api_key($1, $2)`,
      ['rsk_live_eeee', 'hash-e'],
    );
    expect(rows).toEqual([]);
  });

  it('an expired key authenticates to nothing', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash, expires_at)
       values ($1,'k','rsk_live_ffff','hash-f', now() - interval '1 day')`,
      [f.orgA],
    );
    const rows = await db.as(
      { kind: 'anonymous' },
      `select org_id from app.authenticate_api_key($1, $2)`,
      ['rsk_live_ffff', 'hash-f'],
    );
    expect(rows).toEqual([]);
  });

  it('a wrong secret against a real prefix authenticates to nothing', async () => {
    await db.admin(
      `insert into api_keys (org_id, name, prefix, secret_hash) values ($1,'k','rsk_live_gggg','hash-g')`,
      [f.orgA],
    );
    const rows = await db.as(
      { kind: 'anonymous' },
      `select org_id from app.authenticate_api_key($1, $2)`,
      ['rsk_live_gggg', 'wrong'],
    );
    expect(rows).toEqual([]);
  });
});

describe('privilege separation between human and machine principals', () => {
  it('a machine principal cannot decide an approval it requested', async () => {
    const { id } = first(
      await db.admin<{ id: string }>(
        `insert into approval_requests (org_id, lead_id, execution_id, action, policy_reason, payload_digest)
         values ($1,$2,$3,'outreach_send','send is HIGH risk','d1') returning id`,
        [f.orgA, f.leadA, f.executionA],
    ),
      'approval request',
    );
    const rows = await db.as(
      { kind: 'api_key', orgId: f.orgA },
      `update approval_requests set status = 'approved' where id = $1 returning id`,
      [id],
    );
    expect(rows).toEqual([]);
  });

  it('a human member can decide an approval in their own organization', async () => {
    const { id } = first(
      await db.admin<{ id: string }>(
        `insert into approval_requests (org_id, lead_id, execution_id, action, policy_reason, payload_digest)
         values ($1,$2,$3,'outreach_send','send is HIGH risk','d1') returning id`,
        [f.orgA, f.leadA, f.executionA],
    ),
      'approval request',
    );
    const rows = await db.as(
      { kind: 'user', userId: f.memberA, orgId: f.orgA },
      `update approval_requests set status = 'approved', decided_by = $2 where id = $1 returning status`,
      [id, f.memberA],
    );
    expect(rows[0]).toMatchObject({ status: 'approved' });
  });

  it("a human in org A cannot decide org B's approval", async () => {
    const { id } = first(
      await db.admin<{ id: string }>(
        `insert into approval_requests (org_id, lead_id, execution_id, action, policy_reason, payload_digest)
         values ($1,$2,$3,'outreach_send','send is HIGH risk','d1') returning id`,
        [f.orgB, f.leadB, f.executionB],
    ),
      'approval request',
    );
    const rows = await db.as(
      { kind: 'user', userId: f.userA, orgId: f.orgA },
      `update approval_requests set status = 'approved' where id = $1 returning id`,
      [id],
    );
    expect(rows).toEqual([]);
  });

  it('a machine principal cannot publish a rubric version', async () => {
    await expect(
      db.as(
        { kind: 'api_key', orgId: f.orgA },
        `insert into rubric_versions (org_id, version, definition) values ($1,'9.9.9','{}'::jsonb)`,
        [f.orgA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a machine principal cannot raise the organization automation level', async () => {
    const rows = await db.as(
      { kind: 'api_key', orgId: f.orgA },
      `update organizations set automation_level = 'outreach_send' where id = $1 returning id`,
      [f.orgA],
    );
    expect(rows).toEqual([]);
    const [check] = await db.admin<{ automation_level: string }>(
      `select automation_level from organizations where id = $1`,
      [f.orgA],
    );
    expect(check!.automation_level).toBe('dry_run');
  });

  it('a non-admin member cannot raise the organization automation level', async () => {
    const rows = await db.as(
      { kind: 'user', userId: f.memberA, orgId: f.orgA },
      `update organizations set automation_level = 'outreach_send' where id = $1 returning id`,
      [f.orgA],
    );
    expect(rows).toEqual([]);
  });
});
