/**
 * Test database harness.
 *
 * Runs against real Postgres either way. With TEST_DATABASE_URL set it is a
 * real server, reached through the production `pg` pool as a real login role;
 * without it, PGlite — Postgres 17 compiled to WebAssembly, where
 * `create policy`, `force row level security`, `set role` and `current_setting`
 * behave exactly as they do on a server.
 *
 * Neither is a mock. The point of the split is that CI and a laptop with no
 * database still run the same assertions as a deployment does.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tx } from '../../src/lib/db/client';
import { realDatabaseUrl, type Principal, type TestDb } from './backend';
import { createPostgresTestDb } from './postgres-backend';

export type { Principal, TestDb } from './backend';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

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

export function migrationSql(): string[] {
  return migrationFiles().map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

export async function createTestDb(): Promise<TestDb> {
  const url = realDatabaseUrl();
  if (url) return createPostgresTestDb(url);
  return createPGliteTestDb();
}

async function createPGliteTestDb(): Promise<TestDb> {
  const pg = await PGlite.create();

  const files = migrationFiles();
  for (const [i, sql] of migrationSql().entries()) {
    try {
      await pg.exec(sql);
    } catch (err) {
      throw new Error(`migration ${files[i]} failed: ${(err as Error).message}`);
    }
  }

  async function inTx<T>(
    orgId: string,
    userId: string,
    body: (run: (sql: string, params: unknown[]) => Promise<unknown[]>) => Promise<T>,
  ): Promise<T> {
    await pg.exec('begin');
    try {
      await pg.query('select set_config($1, $2, true)', ['app.org_id', orgId]);
      await pg.query('select set_config($1, $2, true)', ['app.user_id', userId]);
      await pg.exec('set local role revenue_swarm_app');
      const out = await body(async (sql, params) => (await pg.query(sql, params)).rows);
      await pg.exec('commit');
      return out;
    } catch (err) {
      await pg.exec('rollback').catch(() => undefined);
      throw err;
    }
  }

  return {
    backend: 'pglite',
    async admin<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    async as<T>(principal: Principal, sql: string, params: unknown[] = []) {
      const orgId =
        principal.kind === 'api_key'
          ? principal.orgId
          : principal.kind === 'user'
            ? (principal.orgId ?? '')
            : '';
      const userId = principal.kind === 'user' ? principal.userId : '';
      return inTx(orgId, userId, async (run) => (await run(sql, params)) as T[]);
    },
    async asRawContext<T>(orgId: string, userId: string, sql: string, params: unknown[] = []) {
      return inTx(orgId, userId, async (run) => (await run(sql, params)) as T[]);
    },
    withAppTx<T>(orgId: string, userId: string, fn: (tx: Tx) => Promise<T>) {
      return inTx(orgId, userId, (run) =>
        fn({
          async query<R>(sql: string, params: unknown[] = []) {
            return (await run(sql, params)) as R[];
          },
          async one<R>(sql: string, params: unknown[] = []) {
            return (await run(sql, params))[0] as R | undefined;
          },
        }),
      );
    },
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

  const mkUser = async (email: string) =>
    first(
      await db.admin<{ id: string }>(
        `insert into users (id, email) values (gen_random_uuid(), $1) returning id`,
        [email],
      ),
      'user',
    ).id;
  const userA = await mkUser('owner-a@example.test');
  const userB = await mkUser('owner-b@example.test');
  const memberA = await mkUser('member-a@example.test');

  await db.admin(
    `insert into memberships (org_id, user_id, role) values ($1,$2,'owner'), ($3,$4,'owner'), ($1,$5,'member')`,
    [orgA, userA, orgB, userB, memberA],
  );

  const mkLead = async (org: string, publicId: string, email: string) =>
    first(
      await db.admin<{ id: string }>(
        `insert into leads (org_id, public_id, dedupe_key, email, company_name)
         values ($1,$2,$3,$4,'Acme Test') returning id`,
        [org, publicId, `dk-${publicId}`, email],
      ),
      'lead',
    ).id;
  const leadA = await mkLead(orgA, 'lead_a1', 'a1@example.test');
  const leadB = await mkLead(orgB, 'lead_b1', 'b1@example.test');

  const mkExec = async (org: string, lead: string, trace: string) =>
    first(
      await db.admin<{ id: string }>(
        `insert into executions (org_id, lead_id, trace_id, idempotency_key)
         values ($1,$2,$3,$4) returning id`,
        [org, lead, trace, `idem-${trace}`],
      ),
      'execution',
    ).id;
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
