/**
 * Test database harness.
 *
 * These tests run against PGlite — real Postgres 17 compiled to WebAssembly,
 * not a mock and not an emulation. `create policy`, `force row level security`,
 * `set role` and `current_setting` behave exactly as they do on a server, which
 * is the whole point: a tenant isolation test that runs against a stubbed
 * policy function proves nothing about the policy.
 *
 * The same migration files are applied here and on Supabase.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

export type Principal =
  | { kind: 'api_key'; orgId: string }
  | { kind: 'user'; userId: string; orgId?: string }
  | { kind: 'anonymous' };

export interface TestDb {
  raw: PGlite;
  /** Run SQL with no principal and no RLS — migration and fixture setup only. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run SQL the way the application does: as the non-owning `revenue_swarm_app`
   * role, with the principal expressed only as session settings.
   */
  as<T = Record<string, unknown>>(
    principal: Principal,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

/** Assert-and-unwrap for fixture queries that must return exactly one row. */
export function first<T>(rows: T[], what = 'row'): T {
  const row = rows[0];
  if (!row) throw new Error(`expected one ${what}, got none`);
  return row;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create();

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pg.exec(sql);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }

  async function admin<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await pg.query<T>(sql, params);
    return res.rows;
  }

  async function as<T>(
    principal: Principal,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    // Deliberately mirrors src/lib/db/context.ts. Context is applied with
    // set_config so the value travels as a bound parameter and can never be
    // concatenated into SQL, and is scoped to the transaction so it cannot leak
    // into the next request on a pooled connection.
    const orgId =
      principal.kind === 'api_key'
        ? principal.orgId
        : principal.kind === 'user'
          ? (principal.orgId ?? '')
          : '';
    const userId = principal.kind === 'user' ? principal.userId : '';

    await pg.exec('begin');
    try {
      await pg.query('select set_config($1, $2, true)', ['app.org_id', orgId]);
      await pg.query('select set_config($1, $2, true)', ['app.user_id', userId]);
      await pg.exec('set local role revenue_swarm_app');
      const res = await pg.query<T>(sql, params);
      await pg.exec('commit');
      return res.rows;
    } catch (err) {
      await pg.exec('rollback').catch(() => undefined);
      throw err;
    }
  }

  return {
    raw: pg,
    admin,
    as,
    close: () => pg.close(),
  };
}

/** A two-organization fixture: the substrate for every isolation test. */
export interface TwoOrgFixture {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
  /** Member of A only, role `member` — cannot perform admin-only actions. */
  memberA: string;
  leadA: string;
  leadB: string;
  executionA: string;
  executionB: string;
  rubricA: string;
  /** Real api_keys rows, so audit foreign keys resolve as they do in production. */
  apiKeyA: string;
  apiKeyB: string;
}

export async function seedTwoOrgs(db: TestDb): Promise<TwoOrgFixture> {
  const { id: orgA } = first(
    await db.admin<{ id: string }>(
      `insert into organizations (slug, name) values ('org-a', 'Org A') returning id`,
    ),
    'organization',
  );
  const { id: orgB } = first(
    await db.admin<{ id: string }>(
      `insert into organizations (slug, name) values ('org-b', 'Org B') returning id`,
    ),
    'organization',
  );

  const mkUser = async (email: string) => {
    return first(
      await db.admin<{ id: string }>(
        `insert into users (id, email) values (gen_random_uuid(), $1) returning id`,
        [email],
      ),
      'user',
    ).id;
  };
  const userA = await mkUser('owner-a@example.test');
  const userB = await mkUser('owner-b@example.test');
  const memberA = await mkUser('member-a@example.test');

  await db.admin(
    `insert into memberships (org_id, user_id, role) values ($1,$2,'owner'), ($3,$4,'owner'), ($1,$5,'member')`,
    [orgA, userA, orgB, userB, memberA],
  );

  const mkLead = async (org: string, publicId: string, email: string) => {
    return first(
      await db.admin<{ id: string }>(
        `insert into leads (org_id, public_id, dedupe_key, email, company_name)
         values ($1,$2,$3,$4,'Acme Test') returning id`,
        [org, publicId, `dk-${publicId}`, email],
      ),
      'lead',
    ).id;
  };
  const leadA = await mkLead(orgA, 'lead_a1', 'a1@example.test');
  const leadB = await mkLead(orgB, 'lead_b1', 'b1@example.test');

  const mkExec = async (org: string, lead: string, trace: string) => {
    return first(
      await db.admin<{ id: string }>(
        `insert into executions (org_id, lead_id, trace_id, idempotency_key)
         values ($1,$2,$3,$4) returning id`,
        [org, lead, trace, `idem-${trace}`],
      ),
      'execution',
    ).id;
  };
  const executionA = await mkExec(orgA, leadA, 'trc_a1');
  const executionB = await mkExec(orgB, leadB, 'trc_b1');

  const { id: rubricA } = first(
    await db.admin<{ id: string }>(
      `insert into rubric_versions (org_id, version, status, definition, published_at)
       values ($1, '1.2.0', 'published', $2, now()) returning id`,
      [orgA, JSON.stringify({ thresholds: { HOT: 70, WARM: 45 }, weights: {} })],
    ),
    'rubric version',
  );

  const mkKey = async (org: string, prefix: string) =>
    first(
      await db.admin<{ id: string }>(
        `insert into api_keys (org_id, name, prefix, secret_hash)
         values ($1, 'fixture', $2, $3) returning id`,
        [org, prefix, 'fixture-hash-' + prefix],
      ),
      'api key',
    ).id;
  const apiKeyA = await mkKey(orgA, 'rsk_test_00000000000000a1');
  const apiKeyB = await mkKey(orgB, 'rsk_test_00000000000000b1');

  return {
    orgA, orgB, userA, userB, memberA, leadA, leadB,
    executionA, executionB, rubricA, apiKeyA, apiKeyB,
  };
}
