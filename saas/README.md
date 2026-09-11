# Revenue Swarm — control plane

The standalone SaaS half of Revenue Swarm: Postgres owns the state, this
application owns the trust boundary, and n8n is an execution engine behind it.

```
client ──Bearer rsk_…──▶ POST /v1/leads
                            │  authenticate → resolve organization
                            │  validate → persist lead + execution
                            └─▶ 202 Accepted { trace_id }
                                   │
                                   └─ dispatch (ingest key + HMAC) ─▶ n8n
                                                                       │
   Postgres ◀── record receipt, evidence, approval ◀── signed callback ─┘
```

## Run it locally

No Docker, no Supabase project, no connection string.

```bash
npm install
npx tsx scripts/seed-demo.ts
npm run dev
```

Against a real Postgres server instead — which is what CI and the integration
tests use:

```bash
docker run -d --name revswarm-pg -e POSTGRES_PASSWORD=...   -e POSTGRES_DB=revenue_swarm -p 55432:5432 postgres:17

export ADMIN_DATABASE_URL=postgres://postgres:...@127.0.0.1:55432/revenue_swarm
export APP_DB_PASSWORD=...
npm run db:deploy      # applies every migration, records a checksum for each
npm run db:verify      # 24 structural checks: RLS, FORCE RLS, privileges, triggers
npx tsx scripts/seed-org.ts "Acme" acme owner@example.com crm_write
```

`DATABASE_URL=pglite://.pglite` runs [PGlite](https://pglite.dev) — real
Postgres compiled to WebAssembly. The same migrations, the same
`revenue_swarm_app` role and the same row level security policies apply as on a
server; only the driver differs (`src/lib/db/local.ts`). The seed prints an API
key once and stores only its hash.

```bash
npm test        # 137 tests, against real Postgres policies
npm run typecheck
npm run build
```

## What is where

| Path | What it holds |
| --- | --- |
| `supabase/migrations/` | The schema, the policies, and the two security-definer entry points. Applied verbatim in tests and in production. |
| `src/lib/db/` | `withOrgContext` — the only way application code reaches tenant data. |
| `src/lib/auth/` | API key generation and resolution; session verification; `authenticate()`, the single place identity is decided. |
| `src/lib/hmac.ts` | Canonical signing for both internal hops. |
| `src/lib/schemas.ts` | Every contract that crosses a boundary, as strict Zod objects. |
| `src/lib/leads/`, `executions/`, `approvals/` | Domain logic, taking a `Tx` so tests exercise it under real policies. |
| `src/app/api/` | HTTP surface. Thin: parse, authenticate, delegate. |
| `src/app/` | The product screens. |
| `tests/` | Adversarial suites. See `docs/MULTI-TENANCY.md` for what each one proves. |
| `docs/evidence/` | Output captured from the running application, including the live round trip and the HubSpot objects it created. |
| `scripts/deploy-db.ts` | Applies the migrations to a real server, checksummed. Never rewrites one. |
| `scripts/verify-db.ts` | Asserts the deployed structures exist, so a green test run cannot be green because a policy failed to apply. |

## The three ideas worth reading the code for

**Organization identity is never in a request body.** `LeadIngest` is a strict
schema with no `org_id` and no `tenant_id` field, so a request carrying one is
rejected rather than silently accepted with the field dropped. The organization
comes from the credential, is passed to `withOrgContext` as an argument, and is
installed in the transaction as session state that row level security then
enforces independently.

**A skipped step carries its reason.** `actions_skipped` requires a non-empty
`reason` at the schema level. A trace that omits what did not happen reads as
though nothing was skipped, which is a worse audit than no trace at all.

**An unsupported quote costs points.** The model returns a value from a closed
set plus the verbatim span it read it from. Verification looks for that span in
the source text. When it is absent the signal earns nothing and the rubric's
penalty applies, so a confident fabrication moves the score *down*. See
`docs/evidence/lead-detail-unsupported.txt` for a worked case: −10 instead of
+25, a 35-point swing against being believed.

## Status

| Area | State |
| --- | --- |
| Schema deployed to a real Postgres server | Done — PostgreSQL 17.11, 9 migrations, 24 structural checks |
| Schema deployed to Supabase | **Not done** — no project credentials |
| Adversarial tenancy tests | Done, 27 assertions against real policies on a real server |
| HTTP-level tenancy and callback tests | Done, 32 assertions against a running server |
| Live HubSpot round trip | Done — contact, deal and association in a real portal with synthetic data |
| End-to-end API → engine → CRM | Done. The callback hop from n8n Cloud is blocked by its SSRF guard until there is a public URL |
| Dead-letter queue and replay | Done, in Postgres, preserving the original failure |
| API keys (hash-only storage, column-level privilege) | Done |
| Async lead ingest, dispatch contract, signed callback | Done; dispatch is unexercised against a live n8n webhook |
| Rate limiting on ingestion | Done — per-credential and per-organization, counted in Postgres |
| Approvals, outcomes, receipts, audit log | Done |
| Product screens | Overview, Leads, Lead Detail, Approvals, Evaluations, Settings |
| Human authentication | HS256 Supabase tokens verified; asymmetric JWKS keys not implemented |
| Engine-side approval continuation | Contract defined, engine half not built |
| Deployment | Not deployed; no Supabase project and no Vercel credentials |

Read `docs/SECURITY.md` for the open findings rather than inferring from this
table.
