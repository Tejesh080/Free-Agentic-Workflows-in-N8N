/**
 * Create one organization, one owner, one API key and a published rubric on a
 * real Postgres server.
 *
 *   ADMIN_DATABASE_URL=... npx tsx scripts/seed-org.ts "Acme" acme
 *
 * Prints the API key once. Only its SHA-256 digest is stored, so the value
 * cannot be recovered afterwards — including by the dashboard, which has no
 * privilege to read that column.
 *
 * Separate from seed-demo.ts, which fabricates a whole demo dataset against
 * PGlite. This creates the minimum needed for a real request to succeed.
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { generateApiKey } from '../src/lib/auth/api-key';

const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || url.startsWith('pglite://')) {
  console.error('ADMIN_DATABASE_URL must point at a real Postgres server');
  process.exit(1);
}

const name = process.argv[2] ?? 'Design Partner';
const slug = process.argv[3] ?? 'design-partner';
const email = process.argv[4] ?? 'owner@example.com';
const automation = process.argv[5] ?? 'crm_write';

const RUBRIC = {
  signals: [
    {
      key: 'budget', question: 'Is there a budget?', requires_quote: true, unsupported_penalty: -10,
      values: [
        { value: 'approved', points: 25 }, { value: 'planned', points: 12 },
        { value: 'none', points: 0 }, { value: 'unknown', points: 0 },
      ],
    },
    {
      key: 'authority', question: 'What authority does the contact have?', requires_quote: true, unsupported_penalty: -10,
      values: [
        { value: 'decision_maker', points: 20 }, { value: 'influencer', points: 10 },
        { value: 'individual_contributor', points: 2 }, { value: 'unknown', points: 0 },
      ],
    },
    {
      key: 'timeline', question: 'How soon?', requires_quote: true, unsupported_penalty: -8,
      values: [
        { value: 'immediate', points: 20 }, { value: 'this_quarter', points: 14 },
        { value: 'this_year', points: 6 }, { value: 'none', points: 0 },
      ],
    },
    {
      key: 'icp_fit', question: 'Inside the ICP?', requires_quote: true, unsupported_penalty: -10,
      values: [
        { value: 'core', points: 25 }, { value: 'adjacent', points: 10 },
        { value: 'outside', points: -20 }, { value: 'unknown', points: 0 },
      ],
    },
  ],
  thresholds: { HOT: 70, WARM: 45 },
  force_review_when: [{ signal: 'icp_fit', value: 'outside' }],
};

async function main() {
  const host = new URL(url!).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const c = new Client({
    connectionString: url,
    ssl: isLocal || process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: true },
  });
  await c.connect();

  const existing = await c.query<{ id: string }>('select id from organizations where lower(slug) = lower($1)', [slug]);
  let orgId: string;
  if (existing.rowCount) {
    orgId = existing.rows[0]!.id;
    await c.query('update organizations set automation_level = $2 where id = $1', [orgId, automation]);
    console.log(`\n  organization  ${slug} already exists (${orgId}); automation level set to ${automation}`);
  } else {
    orgId = (
      await c.query<{ id: string }>(
        'insert into organizations (slug, name, automation_level) values ($1,$2,$3) returning id',
        [slug, name, automation],
      )
    ).rows[0]!.id;
    console.log(`\n  organization  ${name} (${orgId})`);
  }

  const userRow = await c.query<{ id: string }>('select id from users where lower(email) = lower($1)', [email]);
  const userId = userRow.rowCount ? userRow.rows[0]!.id : randomUUID();
  if (!userRow.rowCount) {
    await c.query('insert into users (id, email, display_name) values ($1,$2,$3)', [userId, email, 'Owner']);
  }
  await c.query(
    `insert into memberships (org_id, user_id, role) values ($1,$2,'owner')
     on conflict (org_id, user_id) do update set role = 'owner'`,
    [orgId, userId],
  );
  console.log(`  owner         ${email} (${userId})`);

  const published = await c.query('select id from rubric_versions where org_id = $1 and status = $2', [orgId, 'published']);
  if (!published.rowCount) {
    await c.query(
      `insert into rubric_versions (org_id, version, status, definition, notes, published_at, created_by)
       values ($1,'1.2.0','published',$2::jsonb,'Seeded baseline rubric.', now(), $3)`,
      [orgId, JSON.stringify(RUBRIC), userId],
    );
    console.log('  rubric        1.2.0 published');
  } else {
    console.log('  rubric        already published');
  }

  await c.query(
    `insert into integrations (org_id, provider, status, granted_scopes, config)
     values ($1,'hubspot','connected',$2,$3::jsonb)
     on conflict (org_id, provider) do update set status = 'connected'`,
    [
      orgId,
      ['crm.objects.contacts.write', 'crm.objects.deals.write'],
      JSON.stringify({ api_version: '2026-09', deal_stage: 'qualifiedtobuy', create_task: false }),
    ],
  );

  const key = generateApiKey('live');
  await c.query(
    `insert into api_keys (org_id, name, prefix, secret_hash, scopes, created_by)
     values ($1,'Seeded key',$2,$3,$4,$5)`,
    [orgId, key.prefix, key.secretHash, ['leads:write', 'leads:read'], userId],
  );

  console.log(`\n  API KEY (shown once, only its digest was stored):`);
  console.log(`  ${key.token}\n`);
  console.log(`  DEMO_USER_ID=${userId}`);
  console.log(`  organization id=${orgId}\n`);
  await c.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
