# n8n AI Workflows

Fifteen AI workflows for n8n: agents, RAG, model routing, output verification,
human approval, and a revenue pipeline that will not email anyone without one.

`15 workflows` · `352 nodes` · `Live tested in n8n` · `Multi-tenant` · `Evaluated`

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

## How to use

1. Clone the repository, or download a single `workflow.json`.
2. In n8n, choose *Import from File*.
3. Connect the credentials the workflow asks for.
4. For the interconnected setup, follow [docs/CONNECTIONS.md](docs/CONNECTIONS.md).

To take the whole set at once, `python scripts/import-workflows.py` creates all
fifteen and relinks the sub-workflow references for you.

## Shared components

These are not fifteen standalone templates. Eight of them are services the
others call over Execute Sub-workflow — Model Router, Verification, Governance,
Prompt Registry, CRM Sync, Lead Qualification, Outreach Composer and the
Evaluation Harness — so routing, checking, approval, prompt versioning, every
CRM write and rubric promotion are each implemented once.

The revenue pipeline (11–15) is what that buys you: 14 reads as a list of steps
because the judgement lives in the services underneath it. Every HubSpot call in
the whole system happens in three nodes inside 11.

The division of labour is the point. A model turns lead text into labels from a
closed set, with a verbatim quote for each. A fixed rubric turns labels into a
score. Thresholds turn the score into a routing decision. A person approves
anything that leaves the building. The model never produces a number that
anything acts on — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tested

All fifteen were executed on a live n8n instance. The raw test and benchmark
output stays in each workflow folder, next to the workflow it belongs to.

Beyond pass/fail, the scoring rubric is *measured*: a labelled golden set is
scored under the production rubric and a candidate, and a candidate is promoted
only if it regresses on nothing and improves something. The last candidate was
rejected — [evals/README.md](evals/README.md) has the numbers and the rows
behind them.

## Stack

n8n · OpenAI · Anthropic · Gemini · HubSpot · Firecrawl · Qdrant · Postgres · Python

## Setup and safety

With n8n AI Gateway credits the model providers need no API keys of your own.
Published exports are sanitised — no credential ids, instance ids or captured
payloads.

Four limits are deliberate. 01 never executes a write. 10 never executes a
data-changing intent. 14 defaults to `dry_run`, so a fresh import qualifies leads
and drafts messages without touching a CRM or an inbox. And 13 treats a send as a
HIGH-risk action, which means a human approves every outreach until an operator
decides otherwise.

## Documentation

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, and exactly what decides what |
| [docs/SECURITY.md](docs/SECURITY.md) | Severity-rated assessment, including what was found and fixed |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Stage A/B/C, scored, including what not to build |
| [docs/CONNECTIONS.md](docs/CONNECTIONS.md) | Every credential and data table, and how to create it |
| [evals/README.md](evals/README.md) | The golden set and the promotion gate |

Ideas and licensing of the templates that informed this work:
[docs/PROVENANCE.md](docs/PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).
