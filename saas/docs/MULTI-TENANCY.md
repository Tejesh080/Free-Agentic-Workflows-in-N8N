# Multi-tenancy: what is proven, and what the words mean

Two claims are often conflated. This document separates them, because only one
of them is currently supported by evidence.

## Tenant-aware execution — implemented, and was already implemented

The n8n engine keeps workspace state, dedupe and idempotency separated by a
`tenant_id` that travels with each request. Workflow 11's suite proves that two
workspaces sending an identical lead do not share a write ledger entry
(`C08`/`C08x`, execution `901`), and workflow 14's proves the same at the
orchestrator level (`S07`/`S07x`, execution `911`).

That is real and useful. It is **not** multi-tenant security, because at the n8n
boundary `tenant_id` is asserted by the caller. A caller naming an organization
is not authentication.

## Tenant isolation at the authenticated boundary — implemented and tested

This is what the control plane adds. The organization is derived from a
credential, never read from a request, and Postgres enforces it a second time.

### The mechanism

```
Bearer rsk_live_…
   │
   ├─ parseApiKey()                     shape-check; malformed never reaches the database
   ├─ app.authenticate_api_key(prefix, sha256(secret))
   │     security definer, returns nothing for unknown / wrong / revoked / expired
   │     alike, so the caller cannot tell those cases apart
   │
   └─ Principal { orgId }               an argument, not a field in the body
         │
         └─ withOrgContext(principal, fn)
               BEGIN
               select set_config('app.org_id', $1, true)   ← bound parameter
               select set_config('app.user_id', $2, true)
               SET LOCAL ROLE revenue_swarm_app            ← not the table owner
               … caller's queries …
               COMMIT
```

Every policy is written against one predicate, `app.has_org_access(org)`, which
is true when the session's organization matches the row's, or when the session's
user has a proven membership in the row's organization. It returns **false** when
neither is present, so a connection with no context reads zero tenant rows rather
than all of them.

Four independent controls, not one:

1. **Application authorization** — `authenticate()` is the only place identity is
   decided, and the strict request schemas reject an `org_id` field outright.
2. **Database session context** — installed with `set_config(…, is_local => true)`,
   so it is scoped to the transaction and cannot survive on a pooled connection
   into the next request.
3. **RLS `USING`** — which rows are visible and updatable.
4. **RLS `WITH CHECK`** — which rows may be written. A policy with only `USING`
   would let org A insert a row owned by org B, or move its own row into B.

Plus `FORCE ROW LEVEL SECURITY` on every table, so the policies still apply if
the application is ever misconfigured to connect as the owner.

### The assertions

Backend for the run recorded below: **PostgreSQL 17.11**, application role
`revenue_swarm_app`, one database per test cloned from a migrated template.

`tests/rls-tenancy.test.ts`, 27 assertions, run against the real migrations as
the real non-owning role.

**As of 2026-09-12 these run against a real Postgres server**, not only against
PGlite: PostgreSQL 17.11, reached through the same `pg` pool the application
uses in production, with `revenue_swarm_app` authenticating over TCP with its
own password. No implementation change was needed to get there — nothing behaved
differently between the two backends.

That closes three gaps PGlite cannot cover: the production driver and pool code
path, a genuine second login role rather than `SET ROLE` from a superuser, and
server-side database-level privileges. `TEST_DATABASE_URL` selects the server;
without it the suite still runs on PGlite, so CI and a laptop with no database
run the same assertions.

**It is still not the deployed Supabase project** — see "What this does not yet
prove". Nothing is stubbed in either case.

| What was attempted | Result |
| --- | --- |
| API key for A reads leads | Only A's row returned |
| User in A reads B's lead by explicit id | Empty |
| Probe for B's lead vs. a random uuid | Byte-identical empty results, so the API cannot confirm B's object exists |
| A reads B's rows across 11 tenant-owned tables, each seeded with a B row | Zero rows from every table |
| A updates B's lead | Zero rows affected; B's data unchanged |
| A deletes B's lead | Zero rows affected; row still present |
| A inserts a lead claiming `org_id = B` | Rejected — `new row violates row-level security policy` |
| A updates its own lead to set `org_id = B` | Rejected by `WITH CHECK`; row still in A |
| A deletes its own lead (admin) | Succeeds — the delete policy is enabled, not merely absent |
| Non-admin member deletes a lead in their own org | Zero rows affected |
| Session with no organization context reads leads | Empty |
| Session with no context inserts a lead | Rejected |
| Valid signed-in user with no membership in the named org | Empty |
| `app.org_id` set to `'not-a-uuid'` | Empty — a malformed context is absent, never a wildcard |
| Application role selects `secret_hash` | `permission denied` — the column privilege is absent, so this fails before RLS is consulted |
| Non-admin member lists API keys | Empty |
| Machine principal enumerates API keys, including its own | Empty |
| `authenticate_api_key` with a valid key | Resolves to its own organization only |
| …with a revoked key | No rows |
| …with an expired key | No rows |
| …with a wrong secret against a real prefix | No rows |
| Machine principal approves the request its own run created | Zero rows affected |
| Human member approves in their own organization | Succeeds |
| Human in A approves B's request | Zero rows affected |
| Machine principal inserts a rubric version | Rejected |
| Machine principal raises the organization automation level | Zero rows affected; level unchanged |
| Non-admin member raises the automation level | Zero rows affected |

All 27 pass.

### Note on "zero rows" versus "rejected"

Some attempts raise and some quietly affect nothing. That is Postgres working as
designed, and the distinction is worth understanding rather than papering over:

- An **INSERT** or an **UPDATE** whose *new* row fails `WITH CHECK` raises
  `new row violates row-level security policy`. The statement is refused.
- A **SELECT**, **UPDATE** or **DELETE** whose *existing* rows fail `USING` is
  filtered: the statement succeeds and matches nothing.

The second is the safer failure mode of the two — it cannot be used as an
oracle, because it looks identical to "no such row". The tests assert the
*effect* (zero rows, and the target data unchanged) rather than expecting an
error, because asserting an error where none should occur would be asserting the
wrong thing.

## The HTTP boundary

Added 2026-09-12: `tests/http-boundary.test.ts`, **32 assertions against a
running server** and the same real database. These complement the policy tests
and do not replace them — the policy suite proves the database refuses a
cross-tenant read, this one proves the API in front of it does too, which is a
different failure mode (a route that forgets to open an organization context
would pass the first suite and fail this one).

| Attempted over HTTP | Result |
| --- | --- |
| No credential | `401` |
| Malformed credential | `401` |
| Well-formed key, wrong secret | `401` |
| Revoked key | `401` |
| Expired key | `401` |
| All four failure modes | byte-identical response bodies |
| Org A's key lists leads | only A's, B's absent |
| Org A's key fetches B's lead by id | `404` |
| Org B's key fetches A's lead by id | `404` |
| Cross-org id vs. an id that never existed | identical status and body |
| Org A's key fetches B's execution by trace | `404` (own trace: `200`) |
| Body carrying `org_id` | `400 invalid_request`, not a silent drop |
| Body carrying `tenant_id` | `400` |
| Body carrying `latest_score` / `latest_tier` | `400` |
| Machine principal approves an action | `403`, approval still `pending` |
| Org A's key approves B's approval | `403`/`404`, B's still `pending` |
| Rate limit exceeded | `429` with `Retry-After` and `X-RateLimit-*` |
| Security headers on an API response | `nosniff`, `DENY`, `no-referrer`, CSP, no `X-Powered-By` |
| Provoked database error | no Postgres text, no stack trace |

## What this does not yet prove

Stated plainly, because the difference matters:

- **Not the deployed Supabase project.** The server these assertions run against
  is PostgreSQL 17.11 in a container. The migrations are byte-identical to what a
  Supabase project would receive, and `scripts/deploy-db.ts` applies them the
  same way — but Supabase adds its own roles (`anon`, `authenticated`,
  `service_role`), its own PostgREST path and a connection pooler, and none of
  that has been exercised. **Until it has, the wording here stays "a real
  Postgres server" rather than "the deployed Postgres policies".**
- **`service_role` bypasses RLS.** True of any Supabase project, and why no code
  path in this application uses a service-role key. If one is ever introduced for
  an administrative job, these policies stop protecting it.
- **Connection-pool assumptions.** Transaction-scoped `set_config` is correct for
  both session and transaction pooling, and the suite now runs through a real
  `pg` pool. It has still not been tested under PgBouncer in *transaction* mode,
  which is what Supabase's pooler port does.
- **One cross-tenant leak was found here and is worth remembering.** The
  `dead_letter_timeline` view returned every organization's rows, because a
  Postgres view runs with its owner's privileges unless declared
  `security_invoker`. Every policy underneath it was correct. Fixed in migration
  0009, and now asserted both in CI over the migrations and by
  `scripts/verify-db.ts` against a live database. The lesson generalises: RLS on
  a table says nothing about what a view over it exposes.

## The sentence that may and may not be written

May: *"Tenant isolation is enforced by row level security, with 27 adversarial
assertions against the real policies on a real Postgres server, plus 32
HTTP-level assertions against the running API."*

May not, yet: *"Revenue Swarm is a secure multi-tenant SaaS."* Two things are
still missing and both are the same missing thing — a deployment. The policies
have not run on the Supabase project that will actually hold customer data, and
the public n8n webhook is still reachable from the internet alongside the
authenticated API.
