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

`DATABASE_URL=pglite://.pglite` runs [PGlite](https://pglite.dev) — real
Postgres compiled to WebAssembly. The same migrations, the same
`revenue_swarm_app` role and the same row level security policies apply as on a
server; only the driver differs (`src/lib/db/local.ts`). The seed prints an API
key once and stores only its hash.

```bash
npm test        # 81 tests, all against real Postgres policies
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
| `docs/evidence/` | Output captured from the running application. |

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
| Schema, RLS, adversarial tenancy tests | Done, 27 assertions against real policies |
| API keys (hash-only storage, column-level privilege) | Done |
| Async lead ingest, dispatch contract, signed callback | Done; dispatch is unexercised against a live n8n webhook |
| Approvals, outcomes, receipts, audit log | Done |
| Product screens | Overview, Leads, Lead Detail, Approvals, Evaluations, Settings |
| Human authentication | HS256 Supabase tokens verified; asymmetric JWKS keys not implemented |
| Engine-side approval continuation | Contract defined, engine half not built |
| Deployment | Never deployed; no Supabase project or Vercel target configured |

Read `docs/SECURITY.md` for the open findings rather than inferring from this
table.
