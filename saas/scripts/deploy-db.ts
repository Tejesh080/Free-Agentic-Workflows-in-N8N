/**
 * Apply the migrations to a real Postgres server.
 *
 *   npx tsx scripts/deploy-db.ts            apply anything not yet applied
 *   npx tsx scripts/deploy-db.ts --status   report without changing anything
 *
 * Connects as the owner/superuser using ADMIN_DATABASE_URL (or DATABASE_URL).
 * Works against a local Postgres container and against a Supabase project; the
 * only Supabase-specific step is guarded and reported rather than assumed.
 *
 * Two deliberate boundaries:
 *
 *   1. Migrations are applied verbatim, in filename order, each in its own
 *      transaction, and recorded with a checksum. A file that changed after
 *      being applied is an error, not something to re-run: an edited migration
 *      means the deployed schema and the repository have silently diverged.
 *
 *   2. Giving `revenue_swarm_app` a login and a password happens HERE, not in a
 *      migration. A password does not belong in version control, and the role's
 *      *existence and grants* are schema while its *credentials* are deployment.
 */
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const statusOnly = process.argv.includes('--status');

function fail(message: string): never {
  console.error(`\n  ERROR  ${message}\n`);
  process.exit(1);
}

if (!adminUrl) fail('ADMIN_DATABASE_URL (or DATABASE_URL) is not set');
if (adminUrl.startsWith('pglite://')) {
  fail('ADMIN_DATABASE_URL points at PGlite. This script deploys to a real server.');
}

function sslFor(url: string) {
  if (process.env.DATABASE_SSL === 'disable') return undefined;
  // Supabase and most managed Postgres present a certificate chain that needs
  // the CA bundle; local containers are plaintext. Decide from the host rather
  // than from a flag nobody remembers to set.
  const host = new URL(url).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  return isLocal ? undefined : { rejectUnauthorized: true };
}

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

async function main() {
  const client = new Client({ connectionString: adminUrl, ssl: sslFor(adminUrl!) });
  await client.connect();

  const who = await client.query<{ u: string; d: string; v: string }>(
    'select current_user as u, current_database() as d, version() as v',
  );
  console.log(`\n  connected  ${who.rows[0]!.u}@${who.rows[0]!.d}`);
  console.log(`  server     ${who.rows[0]!.v.split(',')[0]}\n`);

  // The ledger lives in the app schema, which 0001 creates. Bootstrap it here so
  // a first run on an empty database can record 0001 itself.
  await client.query('create schema if not exists app');
  await client.query(`
    create table if not exists app.schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    )`);

  const applied = new Map(
    (
      await client.query<{ name: string; checksum: string; applied_at: Date }>(
        'select name, checksum, applied_at from app.schema_migrations',
      )
    ).rows.map((r) => [r.name, r]),
  );

  const migrations = loadMigrations();
  let changed = 0;

  for (const m of migrations) {
    const prior = applied.get(m.name);

    if (prior && prior.checksum !== m.checksum) {
      fail(
        `${m.name} was applied on ${prior.applied_at.toISOString()} with checksum ` +
          `${prior.checksum}, but the file on disk now hashes to ${m.checksum}. ` +
          `An applied migration must not be edited — add a new one instead.`,
      );
    }

    if (prior) {
      console.log(`  = ${m.name.padEnd(26)} already applied`);
      continue;
    }

    if (statusOnly) {
      console.log(`  + ${m.name.padEnd(26)} PENDING`);
      changed++;
      continue;
    }

    const started = Date.now();
    try {
      await client.query('begin');
      await client.query(m.sql);
      await client.query(
        'insert into app.schema_migrations (name, checksum, duration_ms) values ($1,$2,$3)',
        [m.name, m.checksum, Date.now() - started],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      fail(`${m.name} failed: ${(err as Error).message}`);
    }
    console.log(`  + ${m.name.padEnd(26)} applied in ${Date.now() - started}ms`);
    changed++;
  }

  if (statusOnly) {
    console.log(`\n  ${changed} pending, ${applied.size} applied\n`);
    await client.end();
    return;
  }

  // -------------------------------------------------------------------------
  // Deployment-only: the application role's credentials.
  // -------------------------------------------------------------------------
  const appPassword = process.env.APP_DB_PASSWORD;
  if (appPassword) {
    // Quoted as a literal, not interpolated: this is the one place a secret
    // reaches SQL, and it must not be able to terminate the statement.
    await client.query(`alter role revenue_swarm_app login password ${literal(appPassword)}`);
    // Needed to connect at all; the grants inside the database come from 0005.
    await client.query(
      `grant connect on database ${ident(who.rows[0]!.d)} to revenue_swarm_app`,
    );
    console.log(`\n  role       revenue_swarm_app can now log in (password from APP_DB_PASSWORD)`);
  } else {
    console.log(
      `\n  role       revenue_swarm_app has NOLOGIN — set APP_DB_PASSWORD to give it credentials`,
    );
  }

  // Supabase ships roles the application never uses. If they exist, make sure
  // they were not accidentally granted anything by a migration.
  const supabaseRoles = await client.query<{ rolname: string }>(
    `select rolname from pg_roles where rolname in ('anon','authenticated','service_role')`,
  );
  if (supabaseRoles.rowCount) {
    console.log(
      `  supabase   detected roles: ${supabaseRoles.rows.map((r) => r.rolname).join(', ')}`,
    );
  }

  console.log(`\n  ${changed} migration(s) applied\n`);
  await client.end();
}

/** Postgres literal quoting for the one value that cannot be a bind parameter. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function ident(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
