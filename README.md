# Free Agentic Workflows in n8n

Ten interconnected, production-style **n8n AI workflows**: **AI agents**, a **RAG**
platform, **LLM routing**, output verification, human-in-the-loop governance and
GitOps prompt management. Not ten unrelated templates — four of them are reusable
platform services that the other six call over `Execute Sub-workflow`.

Every workflow here was built, imported and **executed against a live n8n
instance**. The numbers in this repository are measured, and where something was
not measured it says so.

---

## The architecture

```
                    08 GitOps Prompt Management
                    (prompts from Git, by SHA)
                               |
                               v
  input --->  domain workflow  --->  02 Model Router  --->  LLM execution
                               |            (deterministic provider choice)
                               v
                    09 Verification Layer
                    (deterministic checks, then entailment)
                               |
                    +----------+----------+
                    |                     |
                 verified            risky / unverified
                    |                     |
                    v                     v
                 output          05 Governance (HITL)
                                          |
                                          v
                                    decision + audit
```

**Platform services** (reusable, called by the others)

| # | Service | What it guarantees |
| --- | --- | --- |
| **02** | Intelligent Model Router | One place decides which model runs, on explicit rules — not vibes |
| **05** | Agent Governance / HITL | Nothing risky executes without a decision, and CRITICAL denies by default |
| **08** | GitOps Prompt Management | Every prompt is versioned in Git and traceable to a commit SHA |
| **09** | AI Output Verification | Nothing ships unverified, and the check is deterministic first |

**Domain workflows** — 01 API Integration, 03 RAG, 04 Research, 06 Financial
Documents, 07 Analytics, 10 Voice. Each calls the platform services rather than
re-implementing routing, verification, prompts or approvals.

---

## The ten workflows

| # | Workflow | What it does | Status |
| --- | --- | --- | --- |
| [01](workflows/01-autonomous-api-integration-engineer/) | **Autonomous API Integration Engineer** | Parses an OpenAPI spec deterministically, plans an integration, checks every proposed step against the real operation list, gates writes through Governance, and safely probes read-only endpoints. | **LIVE VERIFIED** — readiness 6/6, 2/2 live probes |
| [02](workflows/02-intelligent-model-router/) | **Intelligent Model Router** | Scores Gemini / OpenAI / Anthropic on quality, cost and latency with privacy and capability gates. Cross-vendor fallback on failure. | **LIVE VERIFIED** — 9/9 calls, 9/9 checks |
| [03](workflows/03-production-rag-intelligence/) | **Production RAG Intelligence** | Chunking with metadata, embeddings, metadata-filtered retrieval, hybrid rerank, citation-bound answers, explicit no-answer path. | **LIVE VERIFIED** — 5/5 fixtures |
| [04](workflows/04-autonomous-research-agent/) | **Autonomous Research Agent** | Plans sub-questions, searches the live web, deduplicates evidence, writes a cited report, verifies every claim against retrieved sources. | **LIVE VERIFIED** — 0 fabricated citations |
| [05](workflows/05-agent-governance/) | **Agent Governance and HITL** | LOW/MEDIUM/HIGH/CRITICAL classification, deterministic policy validation, Telegram approval, deny-by-default for CRITICAL. | **LIVE VERIFIED** — 12/12 fixtures |
| [06](workflows/06-financial-document-intelligence/) | **Financial Document Intelligence** | Invoice extraction with arithmetic reconciliation, duplicate fingerprinting, exception taxonomy and human escalation. | **LIVE VERIFIED** — 12/12 fixtures |
| [07](workflows/07-conversational-analytics/) | **Conversational Analytics** | Natural-language analytics where the model never writes SQL — it emits a spec validated against a registry and compiled to a parameterised query. | **LIVE VERIFIED** — demo run, verified 0.87 |
| [08](workflows/08-gitops-prompt-management/) | **GitOps Prompt Management** | Fetches versioned prompts from GitHub at run time, validates variables, returns the blob SHA. Bundled fallback on outage. | **LIVE VERIFIED** — 7/7 fixtures |
| [09](workflows/09-ai-output-verification/) | **AI Output Verification Layer** | JSON Schema, required fields, arithmetic rules, citation existence and safety markers first; LLM entailment only as one weighted signal. | **LIVE VERIFIED** — 10/10 fixtures |
| [10](workflows/10-realtime-voice-agent/) | **Real-Time Voice Agent** | Webhook to speech: transcribe, classify against a closed tool registry, gate data-changing intents, verify, speak. Per-stage latency. | **LIVE VERIFIED** — 2/2 runs, real TTS |

**223 nodes across the ten workflows.**

### What "LIVE VERIFIED" means here

The workflow was executed on a real n8n instance, against real model providers
and, where applicable, real external APIs — and its assertions passed. Each
folder's `tests/` or `benchmarks/` file names the n8n execution id.

It does **not** mean load-tested, security-audited, or measured against a
labelled ground-truth set. `docs/PRODUCTION-READINESS.md` is explicit about what
was and was not established.

---

## A few things worth looking at

These are the design decisions the repository actually turns on.

**Hallucinated API endpoints are caught by set membership, not opinion.** 01
checks every `operationId` the model proposes against the operations the
specification declares. A plausible invented endpoint fails with certainty.

**The analytics agent cannot write SQL.** 07's model emits a *query spec*.
A deterministic compiler validates every metric, dimension and filter against a
fixed registry and assembles parameterised SQL from registry column names. Prompt
injection cannot widen what is queryable; the worst it can do is get rejected.

**Fabricated citations are string matching.** 09 extracts every URL and `[S#]`
marker from an answer and checks it against the sources actually supplied. No
second model needed. This is why 04 can report *0 fabricated citations* as a fact.

**The invoice agent is told not to fix the maths.** 06's prompt instructs the
extractor to copy the printed total even when it disagrees with the line items —
because silently correcting it would hide the discrepancy the workflow exists to
find. A separate arithmetic check catches it.

**Governance denies CRITICAL by default.** An unrecognised action type defaults
to HIGH, never LOW. A request whose own text argues it is "pre-approved" is
treated as a suspected prompt injection and raised to CRITICAL.

**Estimates and measurements never share a key.** Router responses carry
`measured.latency_ms` and `estimated.cost_usd` separately, so no document can
quietly present one as the other.

---

## Quick start

```bash
git clone https://github.com/Tejesh080/Free-Agentic-Workflows-in-N8N.git
cd Free-Agentic-Workflows-in-N8N
cp .env.example .env     # add N8N_BASE_URL and N8N_API_KEY
```

**Automated import (recommended).** Creates all ten workflows and rewrites every
sub-workflow reference to the new ids in your instance:

```bash
python scripts/import-workflows.py --dry-run
python scripts/import-workflows.py
```

**Manual import.** In n8n choose *Import from File* and load each
`workflows/*/workflow.json`. Then relink the sub-workflow nodes by hand — they
carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID`, and each one names the
workflow it wants in the node's cached label.

**After importing, either way:**

1. Create the five data tables listed in `docs/CONNECTIONS.md` (the n8n public
   API does not expose data tables, so this step is manual).
2. Select a credential wherever a node asks for one.
3. **Publish 02, 05, 08 and 09 first.** A sub-workflow must be published before
   another workflow can call it.
4. Run each workflow's test-suite or demo trigger to confirm the wiring.

---

## Connections required

Most of this runs with **no API keys of your own** if your n8n has AI Gateway
credits: Gemini, OpenAI, Anthropic and Firecrawl get managed credentials
automatically.

| Service | Needed by | Required? |
| --- | --- | --- |
| n8n instance + API key | import/export scripts | **Required** to use the scripts (not to run the workflows) |
| Gemini / OpenAI / Anthropic | 02, and every workflow through it | **Required** — covered by AI Gateway credits, or bring your own keys |
| OpenAI (Whisper + TTS) | 10 voice | Required for 10 — covered by Gateway credits |
| Firecrawl | 04 research | Required for 04 — covered by Gateway credits |
| GitHub (anonymous) | 08 prompts | No credential needed for a public repo |
| Telegram bot + chat id | 05 human approval | **Optional** — the classifier and all four risk tiers test without it |
| Qdrant | 03 production vector store | **Optional** — the demo runs on the in-memory store |
| Postgres (read-only) | 07 production warehouse | **Optional** — the demo runs on an n8n Data Table |

Full detail, including data table column definitions: **[docs/CONNECTIONS.md](docs/CONNECTIONS.md)**

---

## Security

Published exports are sanitised by `scripts/sanitize-workflow.py`, which strips
credential ids, `meta.instanceId`, `pinData`, webhook ids and top-level workflow
ids, and replaces sub-workflow and data table ids with placeholders.
`scripts/security-check.py` runs before every commit and in CI.

**Warning:** these workflows call external model providers and, in 01 and 04,
external websites. Read what a workflow does before pointing it at anything you
care about. 01 never executes a write operation even when Governance approves it;
10 never executes a data-changing intent. Those limits are deliberate — remove
them only if you understand the consequences.

See **[docs/SECURITY.md](docs/SECURITY.md)**.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the four platform services fit together and why |
| [docs/CONNECTIONS.md](docs/CONNECTIONS.md) | Every credential and data table, with setup steps |
| [docs/SECURITY.md](docs/SECURITY.md) | Sanitisation, threat model, known advisories |
| [docs/TESTING.md](docs/TESTING.md) | How each suite runs and what it proves |
| [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) | Scored rubric, and what is not established |
| [docs/ROI-METHODOLOGY.md](docs/ROI-METHODOLOGY.md) | How time-savings figures are derived, and their assumptions |
| [docs/PROVENANCE.md](docs/PROVENANCE.md) | Where the ideas came from, and licensing |

---

## Provenance

These workflows were **written from scratch**. They were informed by studying a
private archive of community n8n templates, but no source file was copied: those
files carry other operators' instance ids, credential ids and captured runtime
payloads, and their redistribution rights are unknown.
[docs/PROVENANCE.md](docs/PROVENANCE.md) records what was learned from each
source and what is new here.

## Licence

MIT — see [LICENSE](LICENSE). It covers this repository's own contents only.
