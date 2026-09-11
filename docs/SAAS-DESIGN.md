# Stage B design: schema, API boundary, tenant authentication

**Built.** This was the design document; the implementation is in
[`../saas/`](../saas/) and it is what to read for what actually exists —
[`../saas/README.md`](../saas/README.md) for the shape,
[`../saas/docs/CONTRACTS.md`](../saas/docs/CONTRACTS.md) for the four boundaries,
[`../saas/docs/MULTI-TENANCY.md`](../saas/docs/MULTI-TENANCY.md) for what is
proven.

This file is kept as the reasoning behind the decisions rather than a
description of the result. Where the two differ, the code is right and this is
history. Four differences worth naming, because each was a change of mind during
the build:

1. **A session GUC, not a JWT claim, is the primary context.** Policies read
   `app.current_org_id()`, set by the API server with `set_config`, falling back
   to `request.jwt.claim.sub` for a human. That keeps the same policies working
   for an API-key principal, which has no JWT at all.
2. **API key authentication goes through a security-definer function.** The
   design had the server reading `api_keys` directly, which cannot work: reading
   that table needs an organization, and finding the organization is what the
   read is for. `app.authenticate_api_key` is the resolution of that circularity,
   and it also means the application role holds no privilege on `secret_hash`.
3. **The write ledger stays in n8n.** The design said all state moves to
   Postgres. One table should not: it is checked synchronously immediately before
   the HubSpot call, and moving it would put a network round trip inside the
   window it exists to close. See
   [`../saas/docs/N8N-STATE-MIGRATION.md`](../saas/docs/N8N-STATE-MIGRATION.md).
4. **Rate limiting is a Postgres counter, not a platform feature.** Deferring it
   to the deployment meant deferring it indefinitely.

Standalone by construction: this product owns its own database, its own auth,
its own API and its own workflows. It shares an n8n host with other things as
*infrastructure* only — no shared schema, no shared state, no shared workflows,
no cross-references.

---

## 1. Tenant authentication model

**The rule, stated once:** a `tenant_id` in a request body or a header is
**data, never authorisation**. The workspace is derived server-side from a
verified credential and is never read from anything the caller can freely set.

```
inbound request
      │
      ├─ Authorization: Bearer rs_live_<id>.<secret>     (machine / API)
      │        └─► look up key by <id> → verify argon2(secret) → org_id, scopes
      │
      └─ Supabase session cookie / JWT                   (dashboard / human)
               └─► verify JWT → user_id → memberships → org_id, role
      │
      ▼
  request context { org_id, actor, scopes }   ← the ONLY source of tenancy
      │
      ▼
  every query runs as the tenant role with app.org_id set → RLS enforces it
```

Three layers, deliberately redundant:

| Layer | Enforces | Fails how |
| --- | --- | --- |
| **API middleware** | resolves `org_id` from the credential; a body `tenant_id` that disagrees is a `400`, not an override | rejects the request |
| **Query layer** | every statement runs with `SET LOCAL app.org_id` | no rows |
| **RLS policy** | `USING (org_id = current_setting('app.org_id')::uuid)` | no rows, even if the application layer has a bug |

The third layer is the point. Application-level filtering is one forgotten
`WHERE` clause away from a breach; RLS makes the database refuse independently
of whether the code remembered.

### API key format

`rs_live_<key_id>.<secret>` — the `key_id` is an indexed lookup, the secret is
compared against an argon2id hash. Only the hash is stored; the full key is
shown once at creation. Prefix `rs_test_` for sandbox keys, which are bound to
`dry_run: true` at the API layer and cannot be talked out of it.

Scopes: `leads:write`, `leads:read`, `receipts:read`, `evals:run`, `admin`.
The ingest endpoint needs `leads:write` and nothing else, so the key you paste
into a website form handler cannot read your pipeline back out.

### Roles

| Role | Can |
| --- | --- |
| `owner` | everything, including billing and deleting the workspace |
| `admin` | configure ICP, rubrics, integrations, API keys; approve outreach |
| `member` | view leads and receipts; approve outreach |
| `viewer` | view only |

Role is checked in middleware against `memberships`, never inferred from a token
claim the client could mint.

---

## 2. API boundary

n8n is never exposed to customers. It has exactly one caller — this API — and
one way back in: a signed callback.

```
POST   /v1/leads                 ingest one lead            leads:write
POST   /v1/leads/batch           CSV / array, ≤1000         leads:write
GET    /v1/leads                 list, filter, paginate     leads:read
GET    /v1/leads/:id             lead + latest receipt      leads:read
GET    /v1/receipts/:trace_id    full decision receipt      receipts:read
GET    /v1/approvals             pending outreach queue     leads:read
POST   /v1/approvals/:id         approve | edit | reject    leads:write
GET    /v1/evals                 runs and verdicts          receipts:read
POST   /v1/evals                 run a candidate rubric     evals:run
GET    /v1/config/icp            current ICP                leads:read
PUT    /v1/config/icp            new ICP version            admin
GET    /v1/config/rubric         active rubric              leads:read
POST   /v1/integrations/hubspot  begin OAuth                admin
POST   /v1/keys                  mint an API key            admin
DELETE /v1/keys/:id              revoke                     admin

POST   /internal/callbacks/run   n8n → API, HMAC-signed     (not public)
```

**Ingestion is asynchronous.** `POST /v1/leads` validates, writes a `leads` row
and an `executions` row with status `queued`, returns `202` with a `trace_id`,
and triggers n8n. n8n does the work and calls back. The customer polls
`/v1/receipts/:trace_id` or receives a webhook. This matters because a
qualification takes seconds to tens of seconds and a synchronous HTTP API that
blocks that long is a bad API.

**The callback is HMAC-signed** with a per-deployment secret and carries the
`trace_id`; the API verifies the signature and that the `trace_id` belongs to a
run it started. Without that, anything that can reach the callback URL can
fabricate a decision receipt.

**Rate limits** per org, not per IP: `60/min` ingest on the free tier,
`600/min` on paid, `429` with `Retry-After`. Enforced in middleware before any
model is touched, because the thing being protected is spend.

---

## 3. Database schema

Postgres (Supabase). Every tenant-scoped table carries `org_id uuid not null`
and has RLS enabled. Abbreviated for readability; timestamps and indexes are
implied on every foreign key and every `created_at`.

```sql
-- ── identity ────────────────────────────────────────────────────────────────
create table organisations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          citext unique not null,
  plan          text not null default 'trial',
  execution_mode text not null default 'assist',   -- observe | assist | act
  created_at    timestamptz not null default now()
);

-- users live in auth.users (Supabase)

create table memberships (
  org_id  uuid not null references organisations on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role    text not null check (role in ('owner','admin','member','viewer')),
  primary key (org_id, user_id)
);

create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations on delete cascade,
  key_id      text unique not null,          -- the public half, indexed
  secret_hash text not null,                 -- argon2id; the secret is never stored
  name        text not null,
  scopes      text[] not null default '{}',
  mode        text not null default 'live',  -- live | test
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ── configuration ───────────────────────────────────────────────────────────
create table icp_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  version int not null,
  config jsonb not null,
  active boolean not null default false,
  created_by uuid references auth.users,
  created_at timestamptz not null default now(),
  unique (org_id, version)
);

create table rubrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  version text not null,                     -- '1.2.0'
  config jsonb not null,
  active boolean not null default false,
  promoted_from_eval uuid references eval_runs,  -- null = hand-authored
  created_at timestamptz not null default now(),
  unique (org_id, version)
);
-- a rubric may only become active via the promotion gate or an explicit
-- admin override that is recorded in audit_log. Enforced in the API, not here.

create table integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  provider text not null,                    -- hubspot | salesforce | ...
  status text not null default 'disconnected',
  access_token_enc bytea,                    -- pgsodium / KMS, never plaintext
  refresh_token_enc bytea,
  scopes text[],
  expires_at timestamptz,
  connected_by uuid references auth.users,
  unique (org_id, provider)
);

-- ── operational data ────────────────────────────────────────────────────────
create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  lead_key citext not null,                  -- normalised email
  email citext not null,
  company_domain text,
  source text,
  raw jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (org_id, lead_key)                  -- the tenant-scoped dedupe, in the DB
);

create table executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  trace_id text not null,
  lead_id uuid references leads on delete cascade,
  status text not null,                      -- queued|running|succeeded|failed
  dry_run boolean not null default true,
  n8n_execution_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  unique (org_id, trace_id)
);

create table decision_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  trace_id text not null,
  lead_id uuid references leads on delete cascade,
  outcome text not null,                     -- processed|disqualified|duplicate
  score int, tier text, confidence numeric,
  recommended_action text, requires_human_review boolean,
  rubric_version text, icp_version int,
  scoring jsonb,                             -- components, modifiers, caps
  grounding jsonb,                           -- evidence checked / unsupported
  verification jsonb,
  crm jsonb,                                 -- contact/deal/task ids + status
  outreach jsonb,                            -- status, governance, draft
  steps jsonb,                               -- the agent trace
  model_providers text, latency_ms int, cost_usd numeric,
  created_at timestamptz not null default now(),
  unique (org_id, trace_id)
);

create table outreach_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  trace_id text not null, lead_id uuid references leads on delete cascade,
  channel text not null, status text not null,   -- draft|pending|approved|rejected|sent|blocked
  body text, copy_score numeric, blocked_reasons jsonb,
  governance_decision text, risk_level text,
  approved_by uuid references auth.users, approved_at timestamptz,
  sent_at timestamptz
);

create table outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  lead_id uuid not null references leads on delete cascade,
  kind text not null,      -- replied|meeting|opportunity|won|lost|unsubscribed
  value_usd numeric, occurred_at timestamptz not null,
  source text not null,    -- crm_webhook | manual | inferred
  created_at timestamptz not null default now()
);
-- this table is what turns the eval harness from a demo into a flywheel

create table golden_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  case_id text not null, expected_tier text not null, outcome text,
  lead jsonb not null, signals jsonb not null,
  labelled_by uuid references auth.users, labelled_at timestamptz not null default now(),
  active boolean not null default true,
  unique (org_id, case_id)
);
-- the growth path for evals/golden/leads.json; same case shape, so the
-- harness does not change when the source does

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations on delete cascade,
  rubric_a text not null, rubric_b text not null,
  total_cases int not null, sample_seed int,
  metrics jsonb not null, disagreements jsonb,
  promote boolean not null, promote_reason text not null,
  created_at timestamptz not null default now()
);

create table usage_events (
  id bigserial primary key,
  org_id uuid not null references organisations on delete cascade,
  kind text not null,        -- lead_processed | model_call | crm_write | outreach_sent
  quantity int not null default 1,
  cost_usd numeric not null default 0,
  trace_id text,
  occurred_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  org_id uuid not null references organisations on delete cascade,
  actor_user_id uuid references auth.users,
  actor_api_key_id uuid references api_keys,
  action text not null,      -- rubric.promote | integration.connect | key.revoke
  target text, detail jsonb,
  occurred_at timestamptz not null default now()
);
```

### RLS, applied uniformly

```sql
alter table leads enable row level security;
create policy tenant_isolation on leads
  using      (org_id = current_setting('app.org_id', true)::uuid)
  with check (org_id = current_setting('app.org_id', true)::uuid);
```

The same two-clause policy on every tenant-scoped table. `with check` matters as
much as `using`: without it a caller could *write* a row belonging to another
org even though they could not read it back.

### Retention (M1/M2 in the security assessment)

`leads.raw`, `decision_receipts.grounding` and `outreach_messages.body` carry
personal data. Per-org retention in days, a nightly job that nulls those columns
past the window while keeping scores and outcomes, and a hard-delete path for an
erasure request that cascades from `leads`.

---

## 4. Where n8n sits

n8n keeps exactly what it is good at: durable, inspectable, long-running I/O
with a visual execution log. It stops being a database.

| Concern | Owner |
| --- | --- |
| Tenant identity, auth, RBAC | API |
| Configuration (ICP, rubric, integrations) | Postgres |
| Lead state, receipts, outcomes | Postgres |
| Orchestration, model calls, CRM I/O, governance | n8n |
| Dedupe / idempotency | **both** — DB unique constraint is authoritative, n8n ledger stays as a cheap short-circuit |

Migration is mechanical rather than a redesign, which is the whole reason the
tenant column went in first: each n8n Data Table already has the shape of its
Postgres counterpart. The sequence is: API writes Postgres and calls n8n → n8n
calls back → n8n's own tables become a cache → drop them.

---

## 5. Proving isolation

n8n fixtures prove the *engine* keeps tenants apart. They say nothing about
entitlement. Stage B needs adversarial tests at the API and database boundary,
and these are the acceptance criteria:

| Test | Expected |
| --- | --- |
| Org A key requests org B's lead by id | `404`, not `403` — a 403 confirms the id exists |
| Org A key posts a lead with `tenant_id: B` in the body | `400`; the body value is never honoured |
| Org A key with `leads:write` calls `GET /v1/leads` | `403` insufficient scope |
| Revoked key | `401` on the next request, no grace |
| `rs_test_` key with `dry_run: false` | forced back to `true`, recorded |
| Direct SQL as the tenant role without `app.org_id` set | zero rows from every table |
| Direct SQL as org A inserting `org_id = B` | rejected by `with check` |
| n8n callback with a valid signature but a `trace_id` from another org | rejected |
| Forged callback signature | rejected |
| Deleting org A | cascades; org B untouched |

Every one of those is a test that fails loudly on a regression, and they are the
evidence that the phrase "secure multi-tenancy" is earned rather than claimed.

---

## 6. Sequencing

1. Schema + RLS + the isolation tests above, with no UI at all.
2. Auth, orgs, memberships, API keys.
3. `POST /v1/leads` → n8n → signed callback → receipt readable. One vertical
   slice, end to end.
4. HubSpot OAuth per org, replacing the single private-app token.
5. Dashboard: Overview, Leads, Lead detail, Decision trace, Approvals,
   Evaluations, Settings.
6. Outcome ingestion from CRM webhooks, which switches the eval flywheel on.

Nothing in steps 1–3 needs a design decision that is not in this document. If
any of it is wrong, it is cheapest to say so now.
