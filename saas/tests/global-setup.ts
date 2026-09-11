/**
 * Builds the template database the real-Postgres backend clones from.
 *
 * Runs once per `vitest run`, not once per test. Each test then gets its own
 * database via `create database … template …`, which is a file copy rather than
 * six migrations, so per-test isolation costs milliseconds.
 *
 * No-op when TEST_DATABASE_URL is unset: the PGlite backend builds its own
 * in-process database per test.
 */
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DB } from './helpers/postgres-backend';

function urlFor(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function setup() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base || base.startsWith('pglite://')) {
    console.log('\n  test backend: PGlite (set TEST_DATABASE_URL for a real server)\n');
    return;
  }

  const admin = new Client({ connectionString: urlFor(base, 'postgres') });
  await admin.connect();

  const version = (await admin.query<{ v: string }>('select version() as v')).rows[0]!.v;
  console.log(`\n  test backend: ${version.split(',')[0]}`);
  console.log(`  template:     ${TEMPLATE_DB}\n`);

  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [TEMPLATE_DB],
  );
  await admin.query(`drop database if exists ${JSON.stringify(TEMPLATE_DB)}`);
  await admin.query(`create database ${JSON.stringify(TEMPLATE_DB)}`);
  await admin.end();

  const target = new Client({ connectionString: urlFor(base, TEMPLATE_DB) });
  await target.connect();
  const dir = join(process.cwd(), 'supabase', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await target.query(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      throw new Error(`template migration ${file} failed: ${(err as Error).message}`);
    }
  }
  await target.end();
}

export async function teardown() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base || base.startsWith('pglite://')) return;
  const admin = new Client({ connectionString: urlFor(base, 'postgres') });
  await admin.connect();
  // Sweep any database a crashed test failed to drop.
  const leftovers = await admin.query<{ datname: string }>(
    `select datname from pg_database where datname like 'revswarm_t_%'`,
  );
  for (const { datname } of leftovers.rows) {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [datname],
    );
    await admin.query(`drop database if exists ${JSON.stringify(datname)}`);
  }
  if (leftovers.rowCount) console.log(`\n  swept ${leftovers.rowCount} leftover test database(s)`);
  await admin.query(`drop database if exists ${JSON.stringify(TEMPLATE_DB)}`);
  await admin.end();
}
