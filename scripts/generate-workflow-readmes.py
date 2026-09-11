#!/usr/bin/env python3
"""Generate each workflow folder's README from the catalog plus its own files.

Facts that must not drift (node counts, entry points, dependency edges, test
results) are read from workflow.json and the tests/benchmarks files rather than
retyped, so a README cannot quietly disagree with what shipped.

Prose that is specific to a workflow lives in DETAIL below.

    python scripts/generate-workflow-readmes.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((ROOT / "catalog" / "workflows.json").read_text(encoding="utf-8"))

SERVICE_NAMES = {
    "02": "Model Router", "05": "Governance", "08": "Prompt Registry", "09": "Verification",
}

DETAIL: dict[str, dict] = {
    "01": {
        "problem": "Reading an unfamiliar API and writing the first integration is slow, and an LLM asked to do it will confidently invent endpoints that do not exist.",
        "how": [
            "Fetch the OpenAPI document and parse it **deterministically** — servers, security schemes, every operation with its parameters, request body, response codes and read/write effect. No model is involved in this step.",
            "Fetch the `api-integration/spec-analyst` prompt from the GitOps registry and ask the Model Router to plan an integration for the stated goal.",
            "**Ground the plan**: every `operation_id` the model proposed must exist in the parsed operation list. Method, path and write effect are taken from the specification, never from the model, and disagreements are reported.",
            "Verify the plan against a JSON Schema through the Verification Layer.",
            "If the plan contains write steps, send them to Governance for a decision.",
            "Probe read-only endpoints against the server the specification declares, and compare the live response fields to what the plan expected.",
            "Emit an integration report with a six-point readiness verdict.",
        ],
        "safety": "Only GET and HEAD are probed, only against the specification's own base URL, and only where the path needs no invented identifier. **Write operations are never executed**, whether or not Governance approved them — the approval is recorded for a human.",
        "limits": [
            "JSON OpenAPI 3 only. YAML specifications are rejected with a clear message.",
            "`$ref` is not dereferenced, so response field checking uses observed keys rather than the resolved schema.",
            "The probe stage cannot exercise endpoints that require authentication.",
        ],
    },
    "02": {
        "problem": "Hard-coding one model into every workflow makes cost, latency and provider outages someone else's problem later. Picking a model with a prompt makes the choice unauditable.",
        "how": [
            "Normalise the request and stamp a start time.",
            "**Decision engine (no LLM).** Hard gates first: privacy locality, JSON-mode capability, minimum quality, context size. Then a weighted score over quality prior, blended token price and latency prior, using the weight profile for the requested objective.",
            "Route to the winning provider's chain node.",
            "On failure, retry three times with backoff, then route the **error output** to a different vendor.",
            "Measure wall-clock latency, estimate tokens and cost, and write a telemetry row.",
        ],
        "safety": "`privacy=local_only` is **refused** rather than silently downgraded to a cloud provider when no local candidate is registered. `force_provider` can bypass the capability gate — it can never bypass the privacy gate.",
        "limits": [
            "Quality priors and prices in the registry are **configured values, not measurements**. Re-check prices before trusting a cost figure.",
            "Token counts are estimated from characters/4; the n8n LangChain chain nodes do not surface provider-reported usage.",
            "No local provider is wired. The registry has a commented example.",
        ],
    },
    "03": {
        "problem": "Most RAG demos retrieve the nearest chunks and let the model talk. That produces confident answers from irrelevant context, ignores document access rules, and gives no way to tell a good retrieval from a bad one.",
        "how": [
            "**Ingest**: chunk at 700 characters with 120 overlap, attaching `doc_id`, `title`, `category`, `audience` and `effective_from` as metadata, embed and store.",
            "**Retrieve** the top-k chunks for the question.",
            "**Filter on metadata** — an `internal` document is never returned to a `public` caller, even when it is the best semantic match.",
            "**Rerank**: `0.7 x normalised vector score + 0.3 x lexical term overlap`. Deterministic, free, and it rescues exact-term matches that embeddings rank low.",
            "**Gate on relevance** — being the closest thing in the store does not make a chunk evidence.",
            "Generate with the `rag/answerer` prompt, requiring `[C#]` citations, then verify the answer against the retrieved chunks.",
        ],
        "safety": "Audience filtering is access control, applied before the model sees anything. Test fixtures R03 and R04 ask the *same question* with different audiences to prove the filter is what blocks the answer, not retrieval luck.",
        "limits": [
            "The demo uses n8n's in-memory Simple Vector Store, which does not survive a restart. Qdrant is the documented production swap.",
            "Retrieval quality has not been measured against a labelled ground-truth set. The fixtures prove behaviour, not ranking quality.",
            "The corpus is eight invented documents.",
        ],
    },
    "04": {
        "problem": "Research agents are the easiest place for an LLM to fabricate a citation, because a plausible URL looks like evidence.",
        "how": [
            "Plan the question into sub-questions and keyword queries using the `research/planner` prompt.",
            "Run each query against live web search and collect results.",
            "**Deduplicate** in two stages: exact match on a normalised URL (tracking parameters, `www.`, fragments and trailing slashes stripped), then near-duplicate detection using 3-word shingles with a Jaccard threshold of 0.8.",
            "Synthesise a report with the `research/synthesiser` prompt, requiring an `[S#]` marker after every factual sentence.",
            "Verify every claim against the collected evidence, and build a provenance map of what was cited, what was collected but unused, and any invented marker.",
        ],
        "safety": "If every search returns nothing the agent stops and reports a gap. It never writes an unsourced answer. Fabricated markers and URLs are detected by string matching against the sources actually retrieved.",
        "limits": [
            "Live web results change, so a re-run will cite different sources.",
            "The entailment judge evaluates at most 15 claims per call; longer reports report `claims_truncated`.",
            "No source-quality weighting: a blog and a primary regulator carry equal weight.",
        ],
    },
    "05": {
        "problem": "Agents that can act need a decision layer that is auditable and that fails closed. Asking a model whether an action is safe is not that layer.",
        "how": [
            "Classify risk **deterministically** from the action type, then raise it on destructive verbs, production targets, monetary amounts, bulk operations, personal data in parameters, low agent confidence, and injection-shaped reasoning.",
            "LOW executes. MEDIUM runs five deterministic policy checks and executes only if all pass. HIGH goes to a human. CRITICAL is denied by default.",
            "Send HIGH and CRITICAL to Telegram and wait, with a 60 minute limit.",
            "Record every decision with its reasons, the decider and an expiry.",
        ],
        "safety": "Levels can only ever be raised, never lowered. An unrecognised action type defaults to **HIGH**, not LOW. A timeout, channel error or malformed response all resolve to **rejected**. A request whose own text argues it is pre-approved is treated as a suspected injection and raised to CRITICAL. Simulated decisions used by tests are written to the ledger as `simulated:test-harness` so they can never be mistaken for real approvals.",
        "limits": [
            "The Telegram approval leg is not covered by the automated suite; the 12 fixtures use `simulate_decision`.",
            "The MEDIUM allow-list of target systems is a demo list and must be replaced for real use.",
            "Approvals are not cryptographically signed.",
        ],
    },
    "06": {
        "problem": "Invoice extraction that only checks 'did the model return JSON' misses the failure that matters: a well-formed record whose numbers do not add up.",
        "how": [
            "Extract fields with the `finance/invoice-extractor` prompt through the Model Router, or accept a supplied extraction for deterministic testing.",
            "**Reconcile arithmetically**: line items summed against the subtotal, subtotal plus tax against the total, quantity times unit price against each line amount — all to a 0.02 tolerance.",
            "Validate document type, required fields, ISO 4217 currency, date sanity and implied tax rate.",
            "Fingerprint on `vendor | invoice number | currency | total` and check the ledger for duplicates.",
            "Score system confidence, verify, and escalate anything with an exception to Governance.",
        ],
        "safety": "The prompt explicitly tells the extractor **not** to correct a printed total that disagrees with the line items — silently fixing it would hide exactly the discrepancy this workflow exists to find. System confidence starts at 1.0 and is only ever reduced by evidence.",
        "limits": [
            "Text in, no OCR or vision stage. Feed it text extracted upstream.",
            "Single currency per document; no FX conversion.",
            "The duplicate fingerprint is exact — a re-issued invoice with a changed number is not caught.",
        ],
    },
    "07": {
        "problem": "Letting an LLM write SQL against a warehouse is the fastest way to turn a prompt injection into a data breach.",
        "how": [
            "Load the metric and dimension registry — the security boundary.",
            "Ask the model, via the `analytics/query-planner` prompt, for a **query spec**: metric names, dimension names, filters, a date range and a limit. Never SQL.",
            "**Validate and compile deterministically.** Every name is checked against the registry and anything unknown is discarded. SQL is assembled from registry column names with user values bound as `$1, $2, ...` parameters.",
            "Execute read-only, aggregate, then narrate the rows with the `analytics/narrator` prompt.",
            "Verify the narration against the returned rows.",
        ],
        "safety": "No model text ever reaches a query string. The worst a prompt injection can achieve is having its spec rejected. The compiled SQL and its bound parameters are returned in every response, so each answer is auditable.",
        "limits": [
            "The demo warehouse is an n8n Data Table with 90 synthetic rows; aggregation happens in memory.",
            "The registry covers four metrics and five dimensions. Anything outside it returns `unsupported`.",
            "No joins across tables.",
        ],
    },
    "08": {
        "problem": "Prompts embedded in workflow JSON cannot be reviewed, diffed, versioned or rolled back, and there is no way to tell which prompt text produced a given output.",
        "how": [
            "Resolve the prompt path and Git ref, defaulting to `main`.",
            "Fetch the file through the GitHub Contents API, retrying three times with backoff and treating a 404 or rate limit as data rather than a crash.",
            "Parse the front matter, validate the caller's variables against the prompt's declared contract, and interpolate.",
            "Return the rendered prompt with its **blob SHA**, so an execution log ties back to exact prompt bytes.",
        ],
        "safety": "In strict mode a prompt with an unfilled `{{placeholder}}` is refused rather than sent to a model, because models handle a literal placeholder unpredictably. On a GitHub outage the service returns a **bundled fallback** for hot-path prompts with `degraded: true` and an explicit issue, so a caller can never silently run on non-Git text believing it came from Git.",
        "limits": [
            "Anonymous GitHub API is 60 requests/hour per IP. Add a token for heavy use.",
            "No caching layer: every render is a live fetch.",
            "Bundled fallbacks exist for two hot-path prompts, not all twelve.",
        ],
    },
    "09": {
        "problem": "'LLM judges LLM' is the standard answer to hallucination and it is not good enough on its own: it is slow, costs a model call, and is itself capable of being wrong.",
        "how": [
            "**Deterministic checks first, always.** JSON Schema conformance, required fields, arithmetic business rules, **citation existence** and safety markers (unfilled placeholders, refusals, echoed prompt injections).",
            "Decompose remaining prose into checkable factual claims, dropping headings, list lead-ins and other document furniture.",
            "Only then, and only if sources were supplied, ask a model to label each claim SUPPORTED, CONTRADICTED or NOT_STATED — one batched call through the Model Router.",
            "Combine into `score = 0.6 x deterministic + 0.4 x groundedness`, and return a machine-readable verdict.",
        ],
        "safety": "The judge can move at most **40%** of the score, and only when it actually ran. A judge that fails or returns malformed JSON degrades to 'not evaluated' rather than scoring zero — and `verified` is then **false**, because grounding was asked for and did not happen. Truncated judge responses are repaired by finding the longest balanced prefix.",
        "limits": [
            "At most 15 claims per call; beyond that `claims_truncated` is reported.",
            "The JSON Schema validator is a documented subset, not a full implementation.",
            "Groundedness quality depends on the judge model.",
        ],
    },
    "10": {
        "problem": "A voice agent that can act on what it thinks it heard is a liability, and a single end-to-end latency number hides where the time actually goes.",
        "how": [
            "Accept audio or text on a webhook and stamp a start time.",
            "Transcribe audio with Whisper, or use the supplied text.",
            "Classify the transcript against a **closed registry** of five intents using the `voice/intent-router` prompt.",
            "Send data-changing intents to Governance.",
            "Execute a restricted tool, compose a short spoken reply, verify it against the tool result, synthesise speech, and respond.",
        ],
        "safety": "The tool surface is a closed registry: an invented intent name becomes `unsupported`, never an undefined action. Whether an intent changes data is declared **in the registry, not by the model**. Even on approval this workflow **does not execute** data-changing intents — the approval is recorded for a human. That is what makes a public webhook demo safe.",
        "limits": [
            "The audio upload path is structurally validated but not exercised end to end; both recorded runs used the text payload. Text-to-speech **is** exercised.",
            "No conversation memory across turns.",
            "Demo tools return invented static data.",
        ],
    },
}


def trigger_names(wf: dict) -> list[str]:
    out = []
    for n in wf.get("nodes") or []:
        t = str(n.get("type", "")).lower()
        if "trigger" in t or t.endswith("webhook"):
            out.append(f"`{n['name']}`")
    return out


def read_evidence(folder: Path) -> tuple[str, list[str]]:
    lines: list[str] = []
    headline = ""
    for sub in ("tests", "benchmarks"):
        for f in sorted((folder / sub).glob("*.json")):
            data = json.loads(f.read_text(encoding="utf-8"))
            rel = f"{sub}/{f.name}"
            if "passed" in data and "total" in data:
                headline = headline or f"{data['passed']}/{data['total']} assertions passed"
                lines.append(f"- **{data['passed']}/{data['total']} passed** — [`{rel}`]({rel})"
                             + (f" (n8n execution `{data['n8n_execution_id']}`)" if data.get("n8n_execution_id") else ""))
            elif data.get("runs"):
                n = len(data["runs"])
                lines.append(f"- **{n} recorded run(s)** — [`{rel}`]({rel})")
            else:
                lines.append(f"- [`{rel}`]({rel})")
            if data.get("note"):
                lines.append(f"  - {data['note']}")

    # A folder with no suite still has evidence if it captured a real run verbatim.
    out = folder / "sample-output.json"
    if not lines and out.exists():
        data = json.loads(out.read_text(encoding="utf-8"))
        exec_id = data.get("n8n_execution_id")
        lines.append("- **1 recorded run** — [`sample-output.json`](sample-output.json)"
                     + (f" (n8n execution `{exec_id}`)" if exec_id else ""))
        if data.get("_note"):
            lines.append(f"  - {data['_note']}")
    return headline, lines


def main() -> int:
    written = 0
    for entry in CATALOG["workflows"]:
        num = entry["number"]
        folder = ROOT / "workflows" / entry["folder"]
        wf = json.loads((folder / "workflow.json").read_text(encoding="utf-8"))
        d = DETAIL[num]

        node_count = len(wf.get("nodes") or [])
        real_nodes = [n for n in wf["nodes"] if not str(n.get("type", "")).endswith("stickyNote")]
        calls = entry.get("calls") or []
        called_by = entry.get("called_by") or []

        p = ["# " + num + " " + entry["name"], ""]
        p.append(f"> {entry['summary']}")
        p.append("")
        # The n8n workflow id stays in the catalog for export-workflows.py, but it is
        # an identifier inside one private instance and means nothing to a reader here.
        p.append(f"**Status:** {entry['status']} · **{node_count} nodes** ({len(real_nodes)} executable)")
        p.append("")

        p.append("## The problem")
        p.append("")
        p.append(d["problem"])
        p.append("")

        p.append("## How it works")
        p.append("")
        for i, step in enumerate(d["how"], 1):
            p.append(f"{i}. {step}")
        p.append("")

        p.append("## Platform services it calls")
        p.append("")
        if calls:
            for c in calls:
                p.append(f"- **{c} {SERVICE_NAMES.get(c, '')}**")
        else:
            p.append("None — this *is* a platform service.")
        p.append("")
        if called_by:
            p.append("Called by: " + ", ".join(f"**{c}**" for c in called_by))
            p.append("")

        p.append("## Safety properties")
        p.append("")
        p.append(d["safety"])
        p.append("")

        p.append("## Triggers")
        p.append("")
        for t in trigger_names(wf):
            p.append(f"- {t}")
        p.append("")

        # Sample IO
        si, so = folder / "sample-input.json", folder / "sample-output.json"
        if si.exists() or so.exists():
            p.append("## Sample input and output")
            p.append("")
            if si.exists():
                p.append("- [`sample-input.json`](sample-input.json)")
            if so.exists():
                p.append("- [`sample-output.json`](sample-output.json) — a verbatim capture of a real run")
            p.append("")

        headline, ev = read_evidence(folder)
        p.append("## Verification")
        p.append("")
        if ev:
            p.extend(ev)
            p.append("")
            p.append("Every figure came from a run on a live n8n instance; the linked files are the raw results.")
        else:
            p.append("- No recorded run in this folder.")
        p.append("")

        p.append("## Connections required")
        p.append("")
        svc = entry.get("external_services") or []
        if svc:
            for s in svc:
                p.append(f"- {s}")
        else:
            p.append("- None beyond the platform services above.")
        if entry.get("credential_note"):
            p.append("")
            p.append(entry["credential_note"])
        p.append("")
        p.append("Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)")
        p.append("")

        p.append("## Limitations")
        p.append("")
        for lim in d["limits"]:
            p.append(f"- {lim}")
        p.append("")

        p.append("## Import")
        p.append("")
        p.append("```bash")
        p.append(f"python scripts/import-workflows.py --only {num}")
        p.append("```")
        p.append("")
        p.append("Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow "
                 "references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be "
                 "relinked — the import script does this automatically.")
        p.append("")

        (folder / "README.md").write_text("\n".join(p), encoding="utf-8")
        written += 1
        print(f"wrote workflows/{entry['folder']}/README.md ({node_count} nodes, {headline or 'runs recorded'})")

    print(f"\n{written} README(s) written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
