# n8n AI Workflows

Ten AI workflows for n8n: agents, RAG, model routing, output verification and human approval.

`10 workflows` · `223 nodes` · `Live tested in n8n`

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

## How to use

1. Clone the repository, or download a single `workflow.json`.
2. In n8n, choose *Import from File*.
3. Connect the credentials the workflow asks for.
4. For the interconnected setup, follow [docs/CONNECTIONS.md](docs/CONNECTIONS.md).

To take the whole set at once, `python scripts/import-workflows.py` creates all ten
and relinks the sub-workflow references for you.

## Shared components

These are not ten standalone templates. Four of them are services the others call
over Execute Sub-workflow — Model Router, Verification, Governance and Prompt
Registry — so routing, checking, approval and prompt versioning are each
implemented once.

## Tested

All ten were executed on a live n8n instance. The raw test and benchmark output
stays in each workflow folder, next to the workflow it belongs to.

## Stack

n8n · OpenAI · Anthropic · Gemini · Qdrant · Postgres · Python

## Setup and safety

With n8n AI Gateway credits the model providers need no API keys of your own.
Published exports are sanitised — no credential ids, instance ids or captured
payloads. Two limits are deliberate: 01 never executes a write, and 10 never
executes a data-changing intent.

Ideas and licensing of the templates that informed this work:
[docs/PROVENANCE.md](docs/PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).
