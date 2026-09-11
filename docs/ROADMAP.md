# Roadmap

Three stages. Stage A finishes what exists. Stage B is the smallest thing an
external customer could actually use. Stage C is what makes it defensible.

Everything below is scored. **Impact** and **SaaS value** are about the product;
**Portfolio** is about what a hiring manager would recognise as difficult.

---

## Stage A — finish the Revenue Swarm (days, not weeks)

The system works end to end in dry run. Stage A is about making the live path
real and the failure path visible.

| Item | Impact | Difficulty | Portfolio | SaaS | Verdict |
| --- | --- | --- | --- | --- | --- |
| HubSpot credential + custom properties, enable the three nodes | 9 | 1 | 3 | 8 | **now** |
| First real write to a sandbox portal, evidence captured | 9 | 2 | 6 | 8 | **now** |
| Error workflow → failure table keyed by `trace_id` | 7 | 2 | 7 | 7 | **now** |
| Per-tenant ingest keys (replaces the one shared secret) | 8 | 3 | 6 | 8 | **now** |
| Email sending on the approved branch | 7 | 3 | 4 | 8 | **now** |
| Grow the golden set to ~50 labelled leads | 6 | 4 | 7 | 6 | **now** |
| Scrape allow-list + internal-IP block | 5 | 2 | 4 | 5 | **now** |
| Field-level PII redaction in receipts | 6 | 3 | 6 | 7 | **now** |

**Architecture:** unchanged. **Database:** one new `swarm_failures` table.
**Tests:** a live-write fixture against a sandbox portal, marked as such so it
never runs in CI. **Observability:** failures become queryable by trace id.
**Docs:** a CONNECTIONS entry per new credential. **Deployment:** still one n8n
instance; no new infrastructure.

---

## Stage B — SaaS MVP (the real work)

The gap between this and a product is not more agents. It is an authenticated
API boundary, a place to put customer configuration, and a screen.

### Architecture

```
Next.js (Vercel)  ──►  API routes + Postgres (Supabase)  ──►  n8n (execution only)
     dashboard            auth · tenants · config · keys        workflows 11-15
                                    │
                                    └── receipts / ledgers / eval runs
```

n8n stops owning state. It becomes what it is good at: a durable, observable
execution engine that the API calls and that writes back.

### Stack, and why each piece earns its place

| Choice | Why | Rejected alternative |
| --- | --- | --- |
| **Next.js on Vercel** | One deploy for dashboard + API; the UI is mostly server-rendered tables | A separate SPA + API is two deploys for no gain at this size |
| **Supabase (Postgres + Auth)** | Row-level security is the cheapest credible tenant isolation available; auth included | Clerk is nicer auth but leaves you writing isolation by hand |
| **Postgres, not n8n Data Tables** | Joins, indexes, retention, migrations, RLS | Data Tables are fine for an engine, not for a product |
| **Stripe** | Billing is not a thing to build | — |
| **Sentry** | Errors in the product layer; n8n covers the engine | — |
| **n8n retained** | It is genuinely good at durable, inspectable, long-running I/O | Rewriting the pipeline in application code would lose the execution log, the retry semantics and the visual trace for no product benefit |

**Explicitly not in Stage B:** Temporal, Inngest, Trigger.dev (n8n already is the
durable executor — adding a second one is two orchestrators and one truth);
Redis (nothing needs a cache yet); Langfuse (the receipt table *is* the trace,
and it is domain-shaped rather than generic); OpenTelemetry (premature at one
service); PostHog (no product analytics question yet worth the integration).

### Database

```sql
organisations(id, name, plan, created_at)
users(id, email, ...)                       -- Supabase auth
memberships(org_id, user_id, role)          -- owner | admin | member
crm_connections(org_id, provider, encrypted_token, status)
icp_profiles(org_id, version, config_json, active)
rubrics(org_id, version, config_json, active, promoted_from_eval_run)
api_keys(org_id, hashed_key, scopes, last_used_at, revoked_at)
leads(org_id, lead_key, email, ...)         -- mirrors swarm_lead_ledger
decision_receipts(org_id, trace_id, ...)    -- mirrors swarm_decision_receipts
outreach_log(org_id, trace_id, ...)
eval_runs(org_id, ...)
usage_events(org_id, kind, cost_usd, occurred_at)
```

Every table carries `org_id` with an RLS policy. The receipt, ledger, outreach
and eval tables already have this shape — that is the point of doing tenancy at
the execution layer first.

### Onboarding

The user never learns what n8n is.

1. **Create workspace** — name, then straight in. No credit card.
2. **Connect CRM** — OAuth to HubSpot. One screen, one button.
3. **Describe who you sell to** — plain language. The system proposes an ICP
   (size bands, use cases, disqualifiers) and shows it as editable fields. This
   is the only place onboarding uses a model, and its output is a form the user
   corrects, not a decision.
4. **Score ten of your real leads** — pulled from the connected CRM, scored in
   dry run. **This is the moment the product is sold or lost.** The user sees
   their own leads with a score, a breakdown, and the evidence quoted. If the
   scores look wrong, they fix the ICP here and re-score.
5. **Choose an automation level** — *Observe* (score only), *Assist* (score +
   CRM write + drafts held for approval), *Act* (approved sends go
   automatically, subject to policy). Default **Assist**.
6. **Approve an outreach sample** — three drafts for real leads. Edit the tone,
   or reject the whole idea and stay on Observe.
7. **Go live** — a webhook URL and an API key, plus a form snippet for people
   who have no engineer.

Steps 4 and 6 exist because trust in this category is earned by showing work on
the customer's own data before asking for permission, not after.

### Dashboard

**Overview** — leads processed, HOT/WARM/COLD split, pipeline value opened,
outreach sent vs blocked, reply rate, meetings, cost per qualified lead,
approval queue depth.

**Lead page** — the decision receipt rendered: contact, score with the component
breakdown, every quoted piece of evidence with a tick or a cross, the verification
result, the drafted message, the governance decision, the CRM objects created, and
a timeline. The question it answers is *"why did it say that?"*, which is the
question that determines whether a sales team trusts it.

**Agent trace** — the `steps` array with timings, including the steps that did
*not* run and why. A skipped step with a reason is more convincing than a green
tick, because it shows the system declining to act.

**Approvals** — the queue. Approve, edit, reject, with the reason recorded.

**Evaluation** — rubric versions, the metric table, disagreements, the promotion
verdict. Almost no SaaS in this category will show you this.

| Item | Impact | Difficulty | Portfolio | SaaS | Verdict |
| --- | --- | --- | --- | --- | --- |
| Postgres + RLS + tenant model | 10 | 6 | 9 | 10 | **build** |
| Auth, orgs, memberships, RBAC | 9 | 4 | 6 | 10 | **build** |
| Per-tenant API keys + rate limiting | 9 | 4 | 7 | 9 | **build** |
| Onboarding flow steps 1–7 | 9 | 6 | 6 | 10 | **build** |
| Lead page + agent trace | 9 | 5 | 9 | 9 | **build** |
| Approval queue UI | 8 | 4 | 6 | 9 | **build** |
| HubSpot OAuth (replacing private tokens) | 8 | 4 | 5 | 9 | **build** |
| Cost + usage metering | 7 | 3 | 6 | 8 | **build** |
| Stripe billing | 6 | 3 | 2 | 8 | **build** |
| CSV import | 6 | 2 | 2 | 7 | **build** |
| Salesforce / Pipedrive / Attio adapters | 5 | 6 | 4 | 6 | **later** — the adapter seam exists; a second CRM before a first paying customer is speculation |
| LinkedIn workflows | 3 | 7 | 2 | 4 | **skip** — ToS risk, and it is the part every competitor already does badly |

---

## Stage C — what makes it defensible

| Item | Impact | Difficulty | Portfolio | SaaS | Verdict |
| --- | --- | --- | --- | --- | --- |
| Closed-loop outcome ingestion (CRM stage changes → `outcome`) | 9 | 5 | 9 | 9 | **build** — this is what turns the eval harness from a demo into a flywheel |
| Per-tenant rubric proposal + backtest + promotion | 9 | 6 | 10 | 9 | **build** |
| Difficulty-aware model routing with recorded quality | 6 | 5 | 7 | 6 | **build, measured** — only if the eval shows a cheap model loses accuracy on hard leads; otherwise it is routing theatre |
| Reply handling and meeting booking | 8 | 6 | 5 | 9 | **build** |
| Lead reactivation sweeps | 6 | 3 | 3 | 7 | **build** |
| Experimentation (A/B on outreach copy) | 7 | 5 | 7 | 7 | **build** |
| Buying-signal detection from third-party data | 5 | 7 | 5 | 6 | **later** — data costs money and the ICP work matters more |
| Multi-agent "swarm" of specialised LLM agents | 2 | 8 | 3 | 2 | **skip** — see below |
| Autonomous prompt/rubric rewriting by a model | 1 | 6 | 2 | 1 | **skip** — see below |
| Vector store / RAG over lead history | 3 | 5 | 3 | 3 | **skip** — a receipt table with a `WHERE` clause answers these questions |

### The two things to refuse

**A larger multi-agent architecture.** Adding Research, Enrichment, Routing,
Strategy, Follow-up and Outcome-Learning agents would triple the latency, the
cost and the failure surface to do what four `if` statements, one scrape and a
scheduler already do. The impressive thing here is not the number of agents; it
is that the count is *four* and each one has a contract and a test suite. A
reviewer who knows this domain will read a ten-agent diagram as inexperience.

**A model that rewrites its own scoring logic.** This is the single most
tempting feature and the one that would make the system untrustworthy. The
closed loop already works: outcomes are recorded, a candidate rubric is authored
by a person or proposed from correlations, and `15` decides by arithmetic. The
model's role stops at reading text. Letting it edit the rubric replaces an
auditable gate with an unfalsifiable one.
