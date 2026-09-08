# BUILD STATE (working notes — not the final README)

n8n instance: `https://tejesh08.app.n8n.cloud`
Project id: `9va16Bl4db8IZ7kC` (personal)
Credentials strategy: **n8n AI Gateway credits** auto-assign managed credentials to
Gemini / OpenAI / Anthropic / Firecrawl nodes, so most systems are live-testable
with **no user API keys**.

## Data tables (shared persistence)

| Table | Id | Used by |
| --- | --- | --- |
| `agentic_router_telemetry` | `LdqKndA7aAPelkQj` | 02 |
| `agentic_governance_decisions` | `ALeKjGvwnCozDFlL` | 05 |
| `agentic_verification_log` | `i02zlZrfRX2z2Sea` | 09 |
| `agentic_invoice_ledger` | `VPK0D0xm7cz5mf2H` | 06 |
| `agentic_analytics_demo` | `KWGMLsFeQhWz1pPi` | 07 |

## Systems

| # | System | Workflow id | Status | Tests |
| --- | --- | --- | --- | --- |
| 01 | Autonomous API Integration Engineer | — | not started | — |
| 02 | Intelligent Model Router | `CICW1oBcK0DYWvUc` | **LIVE VERIFIED**, published | benchmark 9/9 calls ok, 9/9 checks pass (exec 153) |
| 03 | Production RAG Intelligence | — | not started | — |
| 04 | Autonomous Research Agent | — | not started | — |
| 05 | Agent Governance (HITL) | — | in progress | — |
| 06 | Financial Document Intelligence | — | not started | — |
| 07 | Conversational Analytics | — | not started | — |
| 08 | GitOps Prompt Management | — | not started | — |
| 09 | AI Output Verification Layer | `vCn6THeEhjhhhxsy` | **LIVE VERIFIED**, published | 10/10 fixtures pass (exec 174) |
| 10 | Real-Time Voice Agent | — | not started | — |

## Architecture decisions (locked)

1. **Deliverable artifact = sanitised `workflow.json` exported from n8n.** SDK source
   is not kept in the repo (avoids drift between source and live-validated version).
2. **Field named `caller` is forbidden** — n8n Set v2 blocks it as a reserved
   property and fails the node at runtime. Use `source_workflow`.
3. **Execute Sub-workflow double-wraps output** as `{json:{...}}`. Every caller
   unwraps with `(i.json && i.json.json) ? i.json.json : i.json`.
4. **A sub-workflow returns its LAST node's output.** Any service that writes to a
   data table must end with an explicit `Return …` Code node that re-emits the
   verdict, otherwise callers receive a database row.
5. **Sub-workflows must be published** to be callable from a nested execution.
6. **`gpt-5-mini` rejects `temperature`.** Use `reasoningEffort` instead.
7. **`force_provider` bypasses the capability gate but never the privacy gate.**
8. Every service exposes a flat, string-typed `executeWorkflowTrigger` contract so
   callers can map inputs without type coercion surprises.
9. Estimates and measurements are kept in separate keys (`estimated.*` vs
   `measured.*`) so docs can never present one as the other.

## Credentials still required from the user

- **Qdrant** (03): `QDRANT_URL`, `QDRANT_API_KEY` — no free fallback for a real vector DB.
- **Telegram chat id** (05): approval channel target. Bot credential already exists
  (`Telegram account`), chat id is unknown.
- Everything else is covered by Gateway credits or n8n Data Tables.

## Repo work already done

- `.gitignore`, `.gitattributes`, `.env.example`
- `docs/PROVENANCE.md` (licensing / attribution analysis of the source archive)
- `scripts/security-check.py` (secret + credential-id + pinData + instanceId scanner)
- `prompts/`: shared/base-system, shared/structured-output, api-integration/spec-analyst,
  research/planner, research/synthesiser, rag/answerer
- `workflows/02/benchmarks/provider-matrix-2026-09-08.json` (measured)
- `workflows/09/tests/results-2026-09-08.json` (measured, 10/10)

## Still to do

- Build 05, 08, 01, 03, 04, 06, 07, 10
- Remaining prompt files (finance, analytics x2, verification, governance, voice, README)
- Export + sanitise all `workflow.json`
- `scripts/`: validate-workflows, sanitize-workflows, import/export, generate-catalog, validate-prompts
- `.github/workflows/validate.yml`, `security.yml`
- `catalog/workflows.json`
- Per-workflow READMEs, architecture.mmd, sample-input/output
- Root README, docs/ARCHITECTURE, CONNECTIONS, SECURITY, TESTING, ROI-METHODOLOGY, PRODUCTION-READINESS
- Screenshots
- Commit + push
