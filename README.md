# n8n AI Workflows

Sixteen AI workflows for n8n: agents, RAG, model routing, output verification,
human approval, and a revenue pipeline that will not email anyone without one.

`16 workflows` · `372 nodes` · `Live tested in n8n` · `Postgres control plane` ·
`RLS-enforced isolation` · `Evaluated`

<!-- Hero image goes here once there is a real screenshot of a workflow canvas.
     Leave it empty rather than filling it with a mockup. -->

## Workflows

| # | Workflow | What it does |
| --- | --- | --- |
| 01 | [API Integration Engineer](workflows/01-autonomous-api-integration-engineer/) | Reads an OpenAPI spec and grounds every planned call against it |
| 02 | [Intelligent Model Router](workflows/02-intelligent-model-router/) | Picks a model per request from explicit rules, with cross-vendor fallback |
| 03 | [RAG Intelligence](workflows/03-production-rag-intelligence/) | Retrieval with audience filtering, deterministic reranking and cited answers |
| 04 | [Research Agent](workflows/04-autonomous-research-agent/) | Searches the web and checks every claim against what it retrieved |
| 05 | [Human Approval & Governance](workflows/05-agent-governance/) | Risk classification with a human in the loop, denying the worst case by default |
| 06 | [Document Intelligence](workflows/06-financial-document-intelligence/) | Invoice extraction that reconciles the arithmetic, not just the JSON |
| 07 | [Conversational Analytics](workflows/07-conversational-analytics/) | Questions answered in SQL the model never writes |
| 08 | [Prompt Registry](workflows/08-gitops-prompt-management/) | Prompts served from Git, returned with the commit SHA |
| 09 | [Output Verification](workflows/09-ai-output-verification/) | Deterministic checks first; the LLM judge is one weighted signal |
| 10 | [Voice Agent](workflows/10-realtime-voice-agent/) | Speech in and out, behind a closed intent registry and an approval gate |
| 11 | [CRM Sync Service](workflows/11-crm-sync-service/) | Every CRM write, once, however many times the caller retries |
| 12 | [Lead Qualification](workflows/12-lead-qualification-agent/) | The model labels the lead; a fixed rubric does the scoring |
| 13 | [Outreach Composer](workflows/13-outreach-composer/) | Drafts, checks and verifies a message, then asks a human |
| 14 | [Revenue Swarm](workflows/14-revenue-swarm-orchestrator/) | A lead becomes CRM records and a drafted message, or an explained refusal |
| 15 | [Evaluation Harness](workflows/15-evaluation-harness/) | A candidate scoring rubric is promoted by arithmetic, or not at all |
| 16 | [Failure Handler](workflows/16-failure-handler/) | Where a broken production run goes, and how it gets run again |

## How to use

1. Clone the repository, or download a single `workflow.json`.
2. In n8n, choose *Import from File*.
3. Connect the credentials the workflow asks for.
4. For the interconnected setup, follow [docs/CONNECTIONS.md](docs/CONNECTIONS.md).

To take the whole set at once, `python scripts/import-workflows.py` creates all
sixteen and relinks the sub-workflow references for you.

## Shared components

These are not sixteen standalone templates. Nine of them are services the
others call over Execute Sub-workflow — Model Router, Verification, Governance,
Prompt Registry, CRM Sync, Lead Qualification, Outreach Composer and the
Evaluation Harness and the Failure Handler — so routing, checking, approval,
prompt versioning, every CRM write, rubric promotion and every dead letter are
each implemented once.

The revenue pipeline (11–15) is what that buys you: 14 reads as a list of steps
because the judgement lives in the services underneath it. Every HubSpot call in
the whole system happens in three nodes inside 11.

The division of labour is the point. A model turns lead text into labels from a
closed set, with a verbatim quote for each. A fixed rubric turns labels into a
score. Thresholds turn the score into a routing decision. A person approves
anything that leaves the building. The model never produces a number that
anything acts on — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tested

All sixteen were executed on a live n8n instance. The raw test and benchmark
output stays in each workflow folder, next to the workflow it belongs to.

Beyond pass/fail, the scoring rubric is *measured*: a labelled golden set is
scored under the production rubric and a candidate, and a candidate is promoted
only if it regresses on nothing and improves something. The last candidate was
rejected — [evals/README.md](evals/README.md) has the numbers and the rows
behind them.

## The control plane

[`saas/`](saas/) is a standalone Next.js and Postgres application: the
authenticated API, the schema, the row level security policies, the approval
domain, and the product screens. n8n sits behind it as an execution engine.

```
client ──Bearer rsk_…──▶ POST /v1/leads ──▶ 202 { trace_id }
                                │
                                └─ signed dispatch ─▶ n8n (workflows 11–16)
                                                        │
     Postgres ◀── receipt, evidence, approval ◀── signed callback
```

It runs with no infrastructure at all — `npm install && npx tsx
scripts/seed-demo.ts && npm run dev` — because `DATABASE_URL=pglite://.pglite`
runs real Postgres compiled to WebAssembly, applying the same migrations and the
same policies a Supabase project would get. See [saas/README.md](saas/README.md).

## Stack

n8n · OpenAI · Anthropic · Gemini · HubSpot · Firecrawl · Qdrant · Next.js ·
Postgres · Supabase · Python

## Setup and safety

With n8n AI Gateway credits the model providers need no API keys of your own.
Published exports are sanitised — no credential ids, instance ids or captured
payloads.

Four limits are deliberate. 01 never executes a write. 10 never executes a
data-changing intent. 14 defaults to `dry_run`, so a fresh import qualifies leads
and drafts messages without touching a CRM or an inbox. And 13 treats a send as a
HIGH-risk action, which means a human approves every outreach until an operator
decides otherwise.

**On tenancy, precisely:** in the n8n engine, execution is tenant-aware — keys,
ledgers and dedupe are scoped to a workspace, and fixtures fail if two are ever
conflated. But at the n8n boundary `tenant_id` is asserted by the caller, and a
caller naming an organization is not authentication.

The control plane in [`saas/`](saas/) is where that boundary is actually drawn:
organization identity comes from a credential, never from a request body, and
Postgres row level security enforces it again. Twenty-seven adversarial
assertions run against the real policies —
[saas/docs/MULTI-TENANCY.md](saas/docs/MULTI-TENANCY.md) lists each one and is
equally explicit about what is still not proven.

## Documentation

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, and exactly what decides what |
| [docs/SECURITY.md](docs/SECURITY.md) | Severity-rated assessment, including what was found and fixed |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Stage A/B/C, scored, including what not to build |
| [docs/SAAS-DESIGN.md](docs/SAAS-DESIGN.md) | The design the control plane was built from |
| [docs/HUBSPOT-SCOPES.md](docs/HUBSPOT-SCOPES.md) | API-generation decision and least-privilege scopes derived from the actual calls |
| [saas/README.md](saas/README.md) | The control plane: run it, and what is where |
| [saas/docs/MULTI-TENANCY.md](saas/docs/MULTI-TENANCY.md) | Every isolation assertion, and what is still unproven |
| [saas/docs/CONTRACTS.md](saas/docs/CONTRACTS.md) | The four boundaries: public API, dispatch, callback, continuation |
| [saas/docs/SECURITY.md](saas/docs/SECURITY.md) | Control-plane findings, fixed and open |
| [saas/docs/N8N-STATE-MIGRATION.md](saas/docs/N8N-STATE-MIGRATION.md) | Which n8n state moves to Postgres, which does not, and why |
| [saas/docs/EVALUATION.md](saas/docs/EVALUATION.md) | The gate, the dataset's limits, and the closed loop |
| [docs/CONNECTIONS.md](docs/CONNECTIONS.md) | Every credential and data table, and how to create it |
| [evals/README.md](evals/README.md) | The golden set and the promotion gate |

Ideas and licensing of the templates that informed this work:
[docs/PROVENANCE.md](docs/PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).
