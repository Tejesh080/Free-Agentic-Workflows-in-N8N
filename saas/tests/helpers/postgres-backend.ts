/**
 * Real Postgres backend for the test suites.
 *
 * Each test gets its own database, cloned from a template that already has the
 * migrations applied (`create database … template …` is a file copy, so this
 * costs milliseconds rather than re-running six migrations ~90 times).
 *
 * Two pools per database, deliberately:
 *   - `admin`  owner/superuser, for fixture setup and for asserting the stored
 *              state from outside the policies under test
 *   - `app`    a real login as `revenue_swarm_app`, with its own password
 *
 * The second one is what makes this different from PGlite. There, the app role
 * is reached with `SET ROLE` from a superuser session. Here the application role
 * authenticates on its own, over TCP, through a pool — so a privilege that only
 * appeared to be absent because the session could re-acquire it would show up.
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import type { Tx } from '../../src/lib/db/client';
import type { Principal, TestDb } from './backend';

export const TEMPLATE_DB = 'revswarm_test_template';

function adminUrlFor(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

function appUrlFor(baseUrl: string, database: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  u.username = 'revenue_swarm_app';
  u.password = process.env.APP_DB_PASSWORD ?? '';
  return u.toString();
}

function wrap(run: (sql: string, params: unknown[]) => Promise<unknown[]>): Tx {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await run(sql, params)) as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      return (await run(sql, params))[0] as T | undefined;
    },
  };
}

export async function createPostgresTestDb(baseUrl: string): Promise<TestDb> {
  const name = `revswarm_t_${randomBytes(6).toString('hex')}`;

  // The maintenance connection only exists to create and drop the database.
  const maintenance = new Pool({ connectionString: adminUrlFor(baseUrl, 'postgres'), max: 1 });
  await maintenance.query(`create database ${JSON.stringify(name)} template ${JSON.stringify(TEMPLATE_DB)}`);
  // Database-level ACLs live in pg_database and are NOT copied by TEMPLATE, so
  // the application role has to be let in to each clone explicitly.
  await maintenance.query(`grant connect on database ${JSON.stringify(name)} to revenue_swarm_app`);

  const admin = new Pool({ connectionString: adminUrlFor(baseUrl, name), max: 4 });
  const app = new Pool({ connectionString: appUrlFor(baseUrl, name), max: 4 });

  async function adminQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await admin.query(sql, params);
    return res.rows as T[];
  }

  /** One transaction as the application role, with transaction-local context. */
  async function inAppTx<T>(
    orgId: string,
    userId: string,
    body: (run: (sql: string, params: unknown[]) => Promise<unknown[]>) => Promise<T>,
  ): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('begin');
      // Exactly what src/lib/db/client.ts does, including bound parameters.
      await client.query('select set_config($1, $2, true)', ['app.org_id', orgId]);
      await client.query('select set_config($1, $2, true)', ['app.user_id', userId]);
      const out = await body(async (sql, params) => (await client.query(sql, params)).rows);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    backend: 'postgres',
    admin: adminQuery,

    async as<T>(principal: Principal, sql: string, params: unknown[] = []): Promise<T[]> {
      const orgId =
        principal.kind === 'api_key'
          ? principal.orgId
          : principal.kind === 'user'
            ? (principal.orgId ?? '')
            : '';
      const userId = principal.kind === 'user' ? principal.userId : '';
      return inAppTx(orgId, userId, async (run) => (await run(sql, params)) as T[]);
    },

    async asRawContext<T>(orgId: string, userId: string, sql: string, params: unknown[] = []) {
      return inAppTx(orgId, userId, async (run) => (await run(sql, params)) as T[]);
    },

    withAppTx<T>(orgId: string, userId: string, fn: (tx: Tx) => Promise<T>) {
      return inAppTx(orgId, userId, (run) => fn(wrap(run)));
    },

    async close() {
      await Promise.all([admin.end(), app.end()]);
      // Terminate anything lingering, or DROP DATABASE blocks.
      await maintenance.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [name],
      );
      await maintenance.query(`drop database if exists ${JSON.stringify(name)}`);
      await maintenance.end();
    },
  };
}
