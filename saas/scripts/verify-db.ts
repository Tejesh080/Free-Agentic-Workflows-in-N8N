/**
 * Verify a deployed database against what the migrations are supposed to have
 * produced.
 *
 *   npx tsx scripts/verify-db.ts
 *
 * This is not a test suite — it does not attempt attacks. It asserts that the
 * *structures* the tests rely on actually exist on this server, so that a green
 * test run cannot be green because a policy silently failed to apply.
 *
 * Run it after every deployment, including against Supabase.
 */
import { Client } from 'pg';

const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || url.startsWith('pglite://')) {
  console.error('ADMIN_DATABASE_URL must point at a real Postgres server');
  process.exit(1);
}

const EXPECTED_TABLES = [
  'api_keys', 'approval_requests', 'audit_events', 'callback_deliveries',
  'decision_receipts', 'evaluation_runs', 'executions', 'integrations',
  'lead_evidence', 'lead_outcomes', 'leads', 'memberships', 'organizations',
  'rate_limit_counters', 'rubric_versions', 'users',
];

const SECURITY_DEFINER = [
  'has_org_access', 'org_role', 'my_organizations',
  'authenticate_api_key', 'resolve_callback_target',
  'consume_rate_limit', 'prune_rate_limit_counters',
];

const APPEND_ONLY = [
  'decision_receipts', 'callback_deliveries', 'audit_events', 'evaluation_runs',
];

const failures: string[] = [];
const notes: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  const host = new URL(url!).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const c = new Client({
    connectionString: url,
    ssl: isLocal || process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: true },
  });
  await c.connect();

  const meta = await c.query<{ v: string; d: string }>(
    'select version() as v, current_database() as d',
  );
  console.log(`\n  ${meta.rows[0]!.v.split(',')[0]}`);
  console.log(`  database: ${meta.rows[0]!.d}\n`);

  // -- schema ---------------------------------------------------------------
  console.log('SCHEMA');
  const tables = (
    await c.query<{ t: string }>(
      `select table_name as t from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((r) => r.t).filter((t) => t !== 'schema_migrations');
  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t));
  check('all expected tables exist', missing.length === 0, missing.join(', '));
  if (extra.length) notes.push(`unexpected tables present: ${extra.join(', ')}`);

  const enums = (
    await c.query<{ t: string }>(
      `select typname as t from pg_type where typtype='e' and typnamespace='public'::regnamespace order by 1`,
    )
  ).rows.map((r) => r.t);
  check('status enums created', enums.length >= 7, `${enums.length}: ${enums.join(', ')}`);

  const fks = await c.query<{ n: number }>(
    `select count(*)::int as n from pg_constraint where contype='f' and connamespace='public'::regnamespace`,
  );
  check('foreign keys present', fks.rows[0]!.n >= 20, `${fks.rows[0]!.n} constraints`);

  // -- RLS and FORCE RLS ----------------------------------------------------
  console.log('\nROW LEVEL SECURITY');
  const rls = await c.query<{ relname: string; rls: boolean; force: boolean }>(
    `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relname <> 'schema_migrations'
      order by 1`,
  );
  const noRls = rls.rows.filter((r) => !r.rls).map((r) => r.relname);
  const noForce = rls.rows.filter((r) => !r.force).map((r) => r.relname);
  check('RLS enabled on every table', noRls.length === 0, noRls.join(', '));
  check('FORCE RLS on every table', noForce.length === 0, noForce.join(', '));

  const policies = await c.query<{ tablename: string; policyname: string; cmd: string; qual: string | null; withcheck: string | null }>(
    `select tablename, policyname, cmd, qual, with_check as withcheck
       from pg_policies where schemaname='public' order by tablename, policyname`,
  );
  check('policies created', policies.rowCount! >= 30, `${policies.rowCount} policies`);

  const writeWithoutCheck = policies.rows.filter(
    (p) => (p.cmd === 'INSERT' || p.cmd === 'UPDATE' || p.cmd === 'ALL') && !p.withcheck,
  );
  check(
    'every write policy has WITH CHECK',
    writeWithoutCheck.length === 0,
    writeWithoutCheck.map((p) => `${p.tablename}.${p.policyname}`).join(', '),
  );

  // A view over RLS-protected tables runs as its owner unless it is
  // security_invoker, which silently returns every tenant's rows.
  const views = await c.query<{ viewname: string; opts: string[] | null }>(
    `select c.relname as viewname, c.reloptions as opts
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v' order by 1`,
  );
  const leaky = views.rows
    .filter((v) => !(v.opts ?? []).some((o) => o.replace(/\s/g, '') === 'security_invoker=true'))
    .map((v) => v.viewname);
  check('every view is security_invoker', leaky.length === 0, leaky.join(', '));

  // -- functions ------------------------------------------------------------
  console.log('\nFUNCTIONS');
  const fns = await c.query<{ proname: string; secdef: boolean; provolatile: string; config: string[] | null }>(
    `select p.proname, p.prosecdef as secdef, p.provolatile, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' order by 1`,
  );
  const fnNames = fns.rows.map((r) => r.proname);
  const missingFns = SECURITY_DEFINER.filter((f) => !fnNames.includes(f));
  check('all app functions exist', missingFns.length === 0, missingFns.join(', '));

  const notDefiner = SECURITY_DEFINER.filter(
    (f) => fns.rows.some((r) => r.proname === f && !r.secdef),
  );
  check('privileged functions are SECURITY DEFINER', notDefiner.length === 0, notDefiner.join(', '));

  // A security-definer function without a pinned search_path is a privilege
  // escalation waiting for a caller who can create objects.
  const unpinned = fns.rows
    .filter((r) => r.secdef && !(r.config ?? []).some((cfg) => cfg.startsWith('search_path=')))
    .map((r) => r.proname);
  check('SECURITY DEFINER functions pin search_path', unpinned.length === 0, unpinned.join(', '));

  // -- privileges -----------------------------------------------------------
  console.log('\nPRIVILEGES');
  const role = await c.query<{ n: number }>(
    `select count(*)::int as n from pg_roles where rolname='revenue_swarm_app'`,
  );
  check('application role exists', role.rows[0]!.n === 1);

  const notSuper = await c.query<{ super: boolean; bypass: boolean }>(
    `select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname='revenue_swarm_app'`,
  );
  check(
    'application role is not superuser and does not bypass RLS',
    !notSuper.rows[0]!.super && !notSuper.rows[0]!.bypass,
  );

  const hashCol = await c.query<{ n: number }>(
    `select count(*)::int as n from information_schema.column_privileges
      where grantee='revenue_swarm_app' and table_name='api_keys'
        and column_name='secret_hash' and privilege_type='SELECT'`,
  );
  check('application role CANNOT select api_keys.secret_hash', hashCol.rows[0]!.n === 0);

  const hashInsert = await c.query<{ n: number }>(
    `select count(*)::int as n from information_schema.column_privileges
      where grantee='revenue_swarm_app' and table_name='api_keys'
        and column_name='secret_hash' and privilege_type='INSERT'`,
  );
  check('application role CAN insert api_keys.secret_hash', hashInsert.rows[0]!.n === 1);

  const rlTable = await c.query<{ n: number }>(
    `select count(*)::int as n from information_schema.role_table_grants
      where grantee='revenue_swarm_app' and table_name='rate_limit_counters'`,
  );
  check('application role has NO direct grant on rate_limit_counters', rlTable.rows[0]!.n === 0);

  const owner = await c.query<{ n: number }>(
    `select count(*)::int as n from pg_class c join pg_roles r on r.oid=c.relowner
      where c.relnamespace='public'::regnamespace and c.relkind='r' and r.rolname='revenue_swarm_app'`,
  );
  check('application role owns no tables (so FORCE RLS is not its own exemption)', owner.rows[0]!.n === 0);

  // -- triggers -------------------------------------------------------------
  console.log('\nTRIGGERS');
  const triggers = await c.query<{ tgname: string; relname: string }>(
    `select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where not t.tgisinternal and c.relnamespace='public'::regnamespace order by 2,1`,
  );
  check('triggers created', triggers.rowCount! >= 10, `${triggers.rowCount} triggers`);

  const appendOnlyMissing = APPEND_ONLY.filter(
    (t) => !triggers.rows.some((r) => r.relname === t && r.tgname.includes('append_only')),
  );
  check('append-only triggers on immutable tables', appendOnlyMissing.length === 0, appendOnlyMissing.join(', '));

  for (const t of ['rubric_versions_immutable', 'approval_requests_transition']) {
    check(`guard trigger ${t}`, triggers.rows.some((r) => r.tgname === t));
  }

  // -- behavioural spot checks ---------------------------------------------
  console.log('\nBEHAVIOUR');

  // Append-only actually refuses, as owner (so RLS is not what is stopping it).
  await c.query('begin');
  try {
    await c.query(
      `insert into organizations (id, slug, name) values ('00000000-0000-4000-8000-00000000ffff','verify-probe','Verify Probe')`,
    );
    await c.query(
      `insert into audit_events (org_id, actor_type, action, target_type)
       values ('00000000-0000-4000-8000-00000000ffff','system','verify.probe','probe')`,
    );
    let refused = false;
    try {
      await c.query(`update audit_events set action='tampered' where action='verify.probe'`);
    } catch (e) {
      refused = /append-only/i.test((e as Error).message);
    }
    check('append-only trigger refuses UPDATE even as owner', refused);
  } finally {
    await c.query('rollback');
  }

  // Rate limiting actually counts and refuses.
  await c.query('begin');
  try {
    const a = await c.query<{ allowed: boolean; used: number }>(
      `select allowed, used from app.consume_rate_limit('verify:probe', 2, 60)`,
    );
    await c.query(`select app.consume_rate_limit('verify:probe', 2, 60)`);
    const c3 = await c.query<{ allowed: boolean; used: number }>(
      `select allowed, used from app.consume_rate_limit('verify:probe', 2, 60)`,
    );
    check(
      'rate limiter allows within limit and refuses beyond',
      a.rows[0]!.allowed === true && c3.rows[0]!.allowed === false,
      `used=${c3.rows[0]!.used}`,
    );
  } finally {
    await c.query('rollback');
  }

  // A session with no context sees nothing, as the app role.
  await c.query('begin');
  try {
    await c.query(`select set_config('app.org_id','',true)`);
    await c.query(`select set_config('app.user_id','',true)`);
    await c.query('set local role revenue_swarm_app');
    const r = await c.query(`select count(*)::int as n from leads`);
    check('no-context session reads zero leads as the app role', r.rows[0]!.n === 0);
  } finally {
    await c.query('rollback');
  }

  await c.end();

  console.log('');
  for (const n of notes) console.log(`  NOTE  ${n}`);
  if (failures.length) {
    console.log(`\n  ${failures.length} CHECK(S) FAILED\n`);
    process.exit(1);
  }
  console.log(`  all checks passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
