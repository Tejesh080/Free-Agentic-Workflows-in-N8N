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

`tests/rls-tenancy.test.ts`, 27 assertions, run against the real migrations as
the real non-owning role. PGlite is used as the server: genuine Postgres, so
`create policy`, `force row level security`, `set role` and `current_setting`
behave exactly as they do in production. Nothing is stubbed.

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

## What this does not yet prove

Stated plainly, because the difference matters:

- **No live database.** These assertions run against PGlite. The migrations are
  byte-identical to what a Supabase project would receive, but no Supabase
  project exists yet, and Supabase adds its own roles (`anon`, `authenticated`,
  `service_role`) and its own PostgREST path. Applying the migrations there and
  re-running the suite against it is the next step.
- **No HTTP-level test of the boundary.** The suite exercises the service layer
  and the policies. It does not spin up the Next server and fire requests at
  `/v1/leads` with a forged bearer token. The layer it covers is the one where a
  mistake would be exploitable; the layer it does not cover is thin.
- **`service_role` bypasses RLS.** That is true of any Supabase project, and it
  is why no code path in this application uses a service-role key. If one is ever
  introduced for an administrative job, these policies stop protecting it.
- **Connection-pool assumptions.** Transaction-scoped `set_config` is correct for
  both session and transaction pooling. It has not been tested under PgBouncer in
  transaction mode against a real pool.

## The sentence that may and may not be written

May: *"Tenant isolation is enforced by row level security, with 27 adversarial
assertions running against the real policies."*

May not, yet: *"Revenue Swarm is a secure multi-tenant SaaS."* That claim needs
the policies verified on the real database, an authenticated HTTP surface tested
end to end, and a deployment to point at.
