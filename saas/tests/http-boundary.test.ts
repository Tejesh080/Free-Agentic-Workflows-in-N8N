/**
 * HTTP-level tests against a running server and a real Postgres database.
 *
 * These complement the policy tests; they do not replace them. The policy suite
 * proves the database refuses a cross-tenant read. This suite proves the API in
 * front of it does too — that no route forgets to open an organization context,
 * that a body cannot name its own organization, and that the callback
 * endpoint's authentication holds against real requests over the wire.
 *
 * Requires:
 *   TEST_BASE_URL          a running control plane (default http://localhost:3000)
 *   ADMIN_DATABASE_URL     the same database it is connected to, for fixtures
 *   N8N_CALLBACK_SECRET    the master the server is using
 *
 * Skipped, loudly, when those are absent — a security suite that silently
 * passes because it never ran is worse than no suite.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { generateApiKey } from '../src/lib/auth/api-key';
import { callbackTokenFor, signRequest } from '../src/lib/hmac';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const ADMIN = process.env.ADMIN_DATABASE_URL;
const MASTER = process.env.N8N_CALLBACK_SECRET;
const ENABLED = Boolean(ADMIN && MASTER && !ADMIN.startsWith('pglite://'));

const d = ENABLED ? describe : describe.skip;
if (!ENABLED) {
  console.warn(
    '\n  http-boundary suite SKIPPED: set TEST_BASE_URL, ADMIN_DATABASE_URL and ' +
      'N8N_CALLBACK_SECRET, and start the server, to run it.\n',
  );
}

interface Fixture {
  orgA: string; orgB: string;
  keyA: string; keyB: string; keyRevoked: string; keyExpired: string;
  leadAPublic: string; leadBPublic: string;
  traceA: string; execA: string;
  traceB: string; execB: string;
  approvalA: string;
}

let db: Client;
let f: Fixture;

async function seed(): Promise<Fixture> {
  const mkOrg = async (slug: string) =>
    (await db.query<{ id: string }>(
      `insert into organizations (slug, name, automation_level) values ($1,$2,'crm_write') returning id`,
      [slug, slug],
    )).rows[0]!.id;

  const orgA = await mkOrg(`http-a-${Date.now()}`);
  const orgB = await mkOrg(`http-b-${Date.now()}`);

  const mkKey = async (org: string, opts: { revoked?: boolean; expired?: boolean } = {}) => {
    const key = generateApiKey('live');
    await db.query(
      `insert into api_keys (org_id, name, prefix, secret_hash, scopes, revoked_at, expires_at)
       values ($1,'http-test',$2,$3,$4,$5,$6)`,
      [
        org, key.prefix, key.secretHash, ['leads:read', 'leads:write'],
        opts.revoked ? new Date() : null,
        opts.expired ? new Date(Date.now() - 86_400_000) : null,
      ],
    );
    return key.token;
  };

  const keyA = await mkKey(orgA);
  const keyB = await mkKey(orgB);
  const keyRevoked = await mkKey(orgA, { revoked: true });
  const keyExpired = await mkKey(orgA, { expired: true });

  const mkLead = async (org: string, tag: string) => {
    const publicId = `lead_http_${tag}_${Math.random().toString(36).slice(2, 8)}`;
    const id = (await db.query<{ id: string }>(
      `insert into leads (org_id, public_id, dedupe_key, email, company_name)
       values ($1,$2,$3,$4,'HTTP Fixture') returning id`,
      [org, publicId, `dk-${publicId}`, `${tag}@example.com`],
    )).rows[0]!.id;
    return { id, publicId };
  };
  const leadA = await mkLead(orgA, 'a');
  const leadB = await mkLead(orgB, 'b');

  const mkExec = async (org: string, leadId: string, tag: string) => {
    const trace = `trc_http_${tag}_${Math.random().toString(36).slice(2, 10)}`;
    const id = (await db.query<{ id: string }>(
      `insert into executions (org_id, lead_id, trace_id, idempotency_key, status)
       values ($1,$2,$3,$4,'dispatched') returning id`,
      [org, leadId, trace, `idem-${trace}`],
    )).rows[0]!.id;
    return { trace, id };
  };
  const execA = await mkExec(orgA, leadA.id, 'a');
  const execB = await mkExec(orgB, leadB.id, 'b');

  const approvalA = (await db.query<{ id: string }>(
    `insert into approval_requests (org_id, lead_id, execution_id, action, risk_level, policy_reason, payload, payload_digest)
     values ($1,$2,$3,'outreach_send','HIGH','fixture','{}'::jsonb,'d') returning id`,
    [orgA, leadA.id, execA.id],
  )).rows[0]!.id;

  return {
    orgA, orgB, keyA, keyB, keyRevoked, keyExpired,
    leadAPublic: leadA.publicId, leadBPublic: leadB.publicId,
    traceA: execA.trace, execA: execA.id,
    traceB: execB.trace, execB: execB.id,
    approvalA,
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  db = new Client({ connectionString: ADMIN, ssl: undefined });
  await db.connect();
  f = await seed();
}, 60_000);

afterAll(async () => {
  if (!ENABLED) return;
  // Leave nothing behind. A plain DELETE cannot do this: the cascade reaches
  // append-only tables and is refused, which is the point of them. Erasure is a
  // named operation instead — see migration 0007.
  for (const org of [f.orgA, f.orgB]) {
    await db.query('select * from app.erase_organization($1, $2)', [org, 'http-boundary test cleanup']);
  }
  await db.end();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}) } });

const withKey = (key: string, path: string, init: RequestInit = {}) =>
  api(path, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });

// ---------------------------------------------------------------------------

d('API authentication', () => {
  it('rejects a request with no credential', async () => {
    const res = await api('/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed credential', async () => {
    const res = await withKey('not-a-key', '/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('rejects a well-formed key with the wrong secret', async () => {
    // Same prefix shape, different secret. Must be indistinguishable from unknown.
    const bogus = generateApiKey('live').token;
    const res = await withKey(bogus, '/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const res = await withKey(f.keyRevoked, '/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('rejects an expired key', async () => {
    const res = await withKey(f.keyExpired, '/api/v1/leads');
    expect(res.status).toBe(401);
  });

  it('gives every authentication failure the same body', async () => {
    const bodies = await Promise.all(
      [f.keyRevoked, f.keyExpired, generateApiKey('live').token].map(async (k) =>
        (await withKey(k, '/api/v1/leads')).text(),
      ),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('accepts a valid key', async () => {
    const res = await withKey(f.keyA, '/api/v1/leads');
    expect(res.status).toBe(200);
  });
});

d('API tenant isolation', () => {
  it("org A's key sees only org A's leads", async () => {
    const res = await withKey(f.keyA, '/api/v1/leads');
    const body = (await res.json()) as { data: { public_id: string }[] };
    const ids = body.data.map((l) => l.public_id);
    expect(ids).toContain(f.leadAPublic);
    expect(ids).not.toContain(f.leadBPublic);
  });

  it("org A's key cannot fetch org B's lead by id", async () => {
    const res = await withKey(f.keyA, `/api/v1/leads/${f.leadBPublic}`);
    expect(res.status).toBe(404);
  });

  it("org B's key cannot fetch org A's lead by id", async () => {
    const res = await withKey(f.keyB, `/api/v1/leads/${f.leadAPublic}`);
    expect(res.status).toBe(404);
  });

  it('a cross-organization id is indistinguishable from one that never existed', async () => {
    const other = await withKey(f.keyA, `/api/v1/leads/${f.leadBPublic}`);
    const never = await withKey(f.keyA, '/api/v1/leads/lead_does_not_exist_at_all');
    expect(other.status).toBe(never.status);
    expect(await other.text()).toBe(await never.text());
  });

  it("org A's key cannot fetch org B's execution", async () => {
    const mine = await withKey(f.keyA, `/api/v1/executions/${f.traceA}`);
    const theirs = await withKey(f.keyA, `/api/v1/executions/${f.traceB}`);
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
  });

  it('a body naming another organization is rejected, not silently ignored', async () => {
    const res = await withKey(f.keyA, '/api/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'spoof@example.com', org_id: f.orgB, dry_run: true }),
    });
    // 400, because the schema is strict — not 202 with the field dropped.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('a body naming a tenant_id is rejected too', async () => {
    const res = await withKey(f.keyA, '/api/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'spoof2@example.com', tenant_id: 'org-b', dry_run: true }),
    });
    expect(res.status).toBe(400);
  });

  it('a body cannot set its own score or tier', async () => {
    const res = await withKey(f.keyA, '/api/v1/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'spoof3@example.com', latest_score: 100, latest_tier: 'HOT' }),
    });
    expect(res.status).toBe(400);
  });

  it('a machine principal cannot approve an action', async () => {
    const res = await withKey(f.keyA, `/api/v1/approvals/${f.approvalA}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // requireRole refuses a non-user principal before the policy is even reached.
    expect(res.status).toBe(403);
    const still = await db.query<{ status: string }>(
      'select status::text as status from approval_requests where id = $1',
      [f.approvalA],
    );
    expect(still.rows[0]!.status).toBe('pending');
  });

  it("org A's key cannot reach org B's approval either", async () => {
    const bApproval = (await db.query<{ id: string }>(
      `insert into approval_requests (org_id, lead_id, execution_id, action, risk_level, policy_reason, payload, payload_digest)
       values ($1,(select id from leads where org_id=$1 limit 1),$2,'outreach_send','HIGH','fixture','{}'::jsonb,'d2')
       returning id`,
      [f.orgB, f.execB],
    )).rows[0]!.id;
    const res = await withKey(f.keyA, `/api/v1/approvals/${bApproval}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect([403, 404]).toContain(res.status);
    const still = await db.query<{ status: string }>(
      'select status::text as status from approval_requests where id = $1', [bApproval],
    );
    expect(still.rows[0]!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

d('callback security over HTTP', () => {
  const callbackPath = (trace: string) => `/api/internal/executions/${trace}/complete`;

  const validBody = () =>
    JSON.stringify({
      status: 'succeeded',
      decision: 'qualified',
      score: 87,
      tier: 'HOT',
      actions_skipped: [{ action: 'outreach_send', reason: 'automation ceiling is crm_write' }],
    });

  /** Signs exactly the way the n8n Build Callback node does. */
  const send = async (opts: {
    trace: string;
    executionId: string;
    body?: string;
    bodyToSend?: string;
    timestamp?: number;
    nonce?: string;
    secretOverride?: string;
  }) => {
    const path = callbackPath(opts.trace);
    const body = opts.body ?? validBody();
    const token = opts.secretOverride ?? callbackTokenFor(MASTER!, opts.executionId);
    const signed = signRequest({
      secret: token, method: 'POST', path, body,
      timestamp: opts.timestamp, nonce: opts.nonce,
    });
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed },
      body: opts.bodyToSend ?? body,
    });
  };

  it('accepts a correctly signed callback', async () => {
    const res = await send({ trace: f.traceA, executionId: f.execA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; receipt_id: string };
    expect(body.status).toBe('recorded');
    expect(body.receipt_id).toBeTruthy();

    const stored = await db.query<{ status: string; score: number }>(
      `select e.status::text as status, r.score
         from executions e join decision_receipts r on r.execution_id = e.id
        where e.trace_id = $1`,
      [f.traceA],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'succeeded', score: 87 });
  });

  it('rejects a replayed nonce and does not change stored state', async () => {
    const nonce = `replay-${Math.random().toString(36).slice(2)}`;
    const first = await send({ trace: f.traceB, executionId: f.execB, nonce });
    expect(first.status).toBe(200);
    const second = await send({ trace: f.traceB, executionId: f.execB, nonce });
    expect(second.status).toBe(409);

    const receipts = await db.query<{ n: number }>(
      `select count(*)::int as n from decision_receipts r
        join executions e on e.id = r.execution_id where e.trace_id = $1`,
      [f.traceB],
    );
    expect(receipts.rows[0]!.n).toBe(1);
  });

  it('a second completion with a fresh nonce cannot overwrite a terminal result', async () => {
    const rogue = JSON.stringify({ status: 'succeeded', decision: 'overwritten', score: 100, tier: 'HOT' });
    const res = await send({ trace: f.traceA, executionId: f.execA, body: rogue });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('already_complete');

    const stored = await db.query<{ score: number; decision: string; n: number }>(
      `select r.score, r.decision, count(*) over ()::int as n
         from decision_receipts r join executions e on e.id = r.execution_id
        where e.trace_id = $1`,
      [f.traceA],
    );
    expect(stored.rows[0]!.score).toBe(87);
    expect(stored.rows[0]!.decision).toBe('qualified');
    expect(stored.rows[0]!.n).toBe(1);
  });

  it('rejects an unsigned callback', async () => {
    const path = callbackPath(f.traceA);
    const res = await api(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validBody(),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const res = await send({
      trace: f.traceA, executionId: f.execA, secretOverride: 'not-the-right-token-at-all',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a body changed after signing', async () => {
    const body = validBody();
    const tampered = body.replace('"score":87', '"score":100');
    expect(tampered).not.toBe(body);
    const res = await send({ trace: f.traceA, executionId: f.execA, body, bodyToSend: tampered });
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const res = await send({
      trace: f.traceA, executionId: f.execA,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a timestamp far in the future', async () => {
    const res = await send({
      trace: f.traceA, executionId: f.execA,
      timestamp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown trace without revealing that it is unknown', async () => {
    const unknown = await send({ trace: 'trc_does_not_exist_anywhere', executionId: f.execA });
    const badSig = await send({
      trace: f.traceA, executionId: f.execA, secretOverride: 'wrong-token',
    });
    expect(unknown.status).toBe(401);
    expect(badSig.status).toBe(401);
    // Identical body: the endpoint cannot be used to enumerate trace ids, and
    // says nothing about which organization a trace belongs to.
    expect(await unknown.text()).toBe(await badSig.text());
  });

  it("a callback signed with another execution's token cannot redirect state", async () => {
    // Correct trace for B, but signed with A's per-execution key.
    const res = await send({ trace: f.traceB, executionId: f.execA });
    expect(res.status).toBe(401);
  });

  it('a callback cannot mutate a different execution than its trace names', async () => {
    const before = await db.query<{ status: string }>(
      `select status::text as status from executions where id = $1`, [f.execA],
    );
    // Sign correctly for B and send to B; A must be untouched.
    await send({ trace: f.traceB, executionId: f.execB, nonce: `x-${Math.random()}` });
    const after = await db.query<{ status: string }>(
      `select status::text as status from executions where id = $1`, [f.execA],
    );
    expect(after.rows[0]!.status).toBe(before.rows[0]!.status);
  });

  it('the payload cannot carry an organization id', async () => {
    const body = JSON.stringify({
      status: 'succeeded', decision: 'qualified', org_id: f.orgB,
    });
    const res = await send({ trace: f.traceB, executionId: f.execB, body, nonce: `o-${Math.random()}` });
    // Strict schema: rejected as invalid, having already passed authentication.
    expect(res.status).toBe(400);
  });
});

d('rate limiting over HTTP', () => {
  it('returns 429 with Retry-After once the per-key limit is exhausted', async () => {
    const key = generateApiKey('live');
    const org = (await db.query<{ id: string }>(
      `insert into organizations (slug, name) values ($1,$1) returning id`,
      [`rl-${Date.now()}`],
    )).rows[0]!.id;
    await db.query(
      `insert into api_keys (org_id, name, prefix, secret_hash, scopes)
       values ($1,'rl',$2,$3,$4)`,
      [org, key.prefix, key.secretHash, ['leads:write']],
    );

    // Read the limit the SERVER is configured with, not a guess. Each POST does
    // a real dispatch to the engine and takes seconds, so a production default
    // of 60 makes this test impractically slow; the local server runs with a
    // low limit. The assertion is unchanged either way — what is configured is
    // configuration, and the limiter either refuses at it or it does not.
    const limit = Number(process.env.RATE_LIMIT_INGEST_PER_KEY ?? 60);
    if (limit > 12) {
      throw new Error(
        `RATE_LIMIT_INGEST_PER_KEY is ${limit}; set it to <= 12 on the server and in this ` +
          `environment to run this test in reasonable time`,
      );
    }
    // Sent concurrently, on purpose. The limiter uses a fixed window, so a
    // sequential loop at ~1s per request can straddle a window boundary and
    // have the counter reset underneath it — the limiter behaving correctly
    // while the test reads as a failure. A burst lands inside one window.
    const burst = await Promise.all(
      Array.from({ length: limit + 4 }, (_, i) =>
        withKey(key.token, '/api/v1/leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: `rl${i}@example.com`, dry_run: true }),
        }),
      ),
    );
    const refused = burst.filter((r) => r.status === 429);
    const sawLimit: Response | undefined = refused[0];

    // At most `limit` may be accepted, so a burst of limit+4 must see refusals.
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(burst.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(limit);
    expect(Number(sawLimit!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(sawLimit!.headers.get('x-ratelimit-limit')).toBe(String(limit));

    await db.query('select * from app.erase_organization($1, $2)', [org, 'rate limit test cleanup']);
  }, 120_000);
});

d('production response headers', () => {
  it('sets the security headers on an API response', async () => {
    const res = await withKey(f.keyA, '/api/v1/leads');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('does not leak a database error to the client', async () => {
    // A syntactically valid but absent public id must not produce a stack trace
    // or a Postgres message.
    const res = await withKey(f.keyA, '/api/v1/leads/lead_%27%3B--');
    const text = await res.text();
    expect(text).not.toMatch(/postgres|pg_|relation|syntax error|at Object\./i);
  });
});
