#!/usr/bin/env python3
"""Generate each workflow folder's README from the catalog plus its own files.

Facts that must not drift (dependency edges, trigger names, test results) are read
from workflow.json and the tests/benchmarks files rather than retyped, so a README
cannot quietly disagree with what shipped.

Prose that is specific to a workflow lives in DETAIL below. Keep it specific: a
sentence that would read the same under any of the ten does not belong here.

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

# Short display names. The folder names are longer and stay as they are - renaming
# them would break the catalog, the scripts and every existing link.
TITLES = {
    "01": "API Integration Engineer",
    "02": "Intelligent Model Router",
    "03": "RAG Intelligence",
    "04": "Research Agent",
    "05": "Human Approval & Governance",
    "06": "Document Intelligence",
    "07": "Conversational Analytics",
    "08": "Prompt Registry",
    "09": "Output Verification",
    "10": "Voice Agent",
}

DETAIL: dict[str, dict] = {
    "01": {
        "oneline": "Reads an OpenAPI spec, plans an integration, and checks every step the model "
                   "proposes against the operations the spec actually declares.",
        "does": [
            "Parses the spec deterministically — no model touches the operation list.",
            "Grounds the plan: an `operation_id` that is not in the spec fails, so an invented endpoint cannot survive.",
            "Takes method, path and write effect from the spec, never from the model.",
            "Probes only GET and HEAD, only against the spec's own base URL.",
            "Write steps go to Governance and are recorded — never executed.",
        ],
        "flow": """flowchart TD
  A[OpenAPI spec] --> B[Deterministic parse]
  B --> C[Plan integration]
  C --> D{Every operation_id<br/>in the spec?}
  D -->|no| E[Reported as ungrounded]
  D -->|yes| F[Verify plan]
  F --> G[Probe GET / HEAD only]
  G --> H[Readiness report]""",
        "limits": [
            "JSON OpenAPI 3 only. YAML specs are rejected with a clear message.",
            "`$ref` is not dereferenced, so response field checking uses observed keys rather than the resolved schema.",
            "The probe stage cannot exercise endpoints that require authentication.",
        ],
    },
    "02": {
        "oneline": "Picks a model per request from explicit rules, with privacy and capability gates "
                   "and cross-vendor fallback.",
        "does": [
            "Scores Gemini, OpenAI and Anthropic on quality prior, blended token price and latency.",
            "Runs hard gates before scoring: privacy locality, JSON mode, minimum quality, context size.",
            "Refuses `privacy=local_only` rather than quietly downgrading it to a cloud provider.",
            "`force_provider` can bypass the capability gate. It can never bypass the privacy gate.",
            "Retries three times, fails over to a different vendor, and writes a telemetry row.",
        ],
        "flow": """flowchart TD
  A[request] --> B[Privacy + capability gates]
  B --> C[Weighted score<br/>quality · cost · latency]
  C --> D[Chosen provider]
  D -->|3 failures| E[Fallback vendor]
  D --> F[Telemetry row]
  E --> F""",
        "limits": [
            "Quality priors and prices are configured values, not measurements. Re-check prices before trusting a cost figure.",
            "No local provider is wired. The registry has a commented example.",
        ],
    },
    "03": {
        "oneline": "Retrieval with metadata access control, deterministic reranking and "
                   "citation-bound answers.",
        "does": [
            "Chunks with `doc_id`, `title`, `category`, `audience` and `effective_from` metadata.",
            "Filters on audience before the model sees anything — an internal document is never returned to a public caller.",
            "Reranks `0.7 × vector + 0.3 × lexical overlap`, which rescues exact-term matches that embeddings rank low.",
            "Gates on relevance, so closest-in-the-store is not treated as evidence.",
            "Answers with `[C#]` citations and checks them against the chunks that were retrieved.",
        ],
        "flow": """flowchart TD
  A[question] --> B[Retrieve top-k]
  B --> C[Filter by audience]
  C --> D[Rerank<br/>0.7 vector + 0.3 lexical]
  D --> E{Relevant enough?}
  E -->|no| F[Explicit no-answer]
  E -->|yes| G["Answer with C# citations"]
  G --> H[Verify against chunks]""",
        "limits": [
            "The demo uses n8n's in-memory Simple Vector Store, which does not survive a restart. Qdrant is the documented production swap.",
            "Retrieval quality has not been measured against a labelled ground-truth set. The fixtures prove behaviour, not ranking quality.",
            "The corpus is eight invented documents.",
        ],
    },
    "04": {
        "oneline": "Plans sub-questions, searches the live web, and checks every claim in the report "
                   "against the sources it actually retrieved.",
        "does": [
            "Deduplicates twice: exact normalised URL, then 3-word shingles at a Jaccard threshold of 0.8.",
            "Requires an `[S#]` marker after every factual sentence.",
            "Checks each marker and URL against the collected evidence by string match, not by asking another model.",
            "Maps what was cited, what was collected but unused, and any marker that was invented.",
            "Stops and reports a gap when search returns nothing, rather than writing an unsourced answer.",
        ],
        "flow": """flowchart TD
  A[question] --> B[Plan sub-questions]
  B --> C[Live web search]
  C --> D[Deduplicate<br/>URL + shingles]
  D --> E["Synthesise with S# markers"]
  E --> F[Check every claim]
  F --> G[Report + provenance map]""",
        "limits": [
            "The entailment judge evaluates at most 15 claims per call; longer reports report `claims_truncated`.",
            "No source-quality weighting: a blog and a primary regulator carry equal weight.",
        ],
    },
    "05": {
        "oneline": "Deterministic risk classification with a human in the loop, and deny-by-default "
                   "for the worst case.",
        "does": [
            "Scores risk from the action type, then raises it on destructive verbs, production targets, money, bulk operations and personal data.",
            "LOW executes. MEDIUM passes five policy checks first. HIGH waits for a human. CRITICAL is denied.",
            "Levels can only be raised, never lowered; an unrecognised action type defaults to HIGH.",
            "A timeout, a channel error and a malformed reply all resolve to rejected.",
            "A request arguing that it is already pre-approved is treated as a suspected injection and raised to CRITICAL.",
        ],
        "flow": """flowchart TD
  A[action request] --> B[Deterministic risk score]
  B --> C{Level}
  C -->|LOW| D[Execute]
  C -->|MEDIUM| E[5 policy checks]
  E --> D
  C -->|HIGH| F[Human approval<br/>60 min limit]
  C -->|CRITICAL| G[Denied by default]
  D --> H[Decision ledger]
  F --> H
  G --> H""",
        "limits": [
            "The MEDIUM allow-list of target systems is a demo list and must be replaced for real use.",
            "Approvals are not cryptographically signed.",
        ],
    },
    "06": {
        "oneline": "Invoice extraction that checks the arithmetic instead of trusting well-formed JSON.",
        "does": [
            "Reconciles line items against subtotal, subtotal plus tax against total, and quantity × unit price against each line, to 0.02.",
            "Validates document type, required fields, ISO 4217 currency, date sanity and implied tax rate.",
            "Fingerprints on vendor, invoice number, currency and total, and checks a ledger for duplicates.",
            "Tells the extractor **not** to correct a printed total that disagrees with the lines — fixing it silently would hide the discrepancy.",
            "Escalates anything carrying an exception to Governance.",
        ],
        "flow": """flowchart TD
  A[invoice text] --> B[Extract fields]
  B --> C[Arithmetic reconciliation]
  C --> D[Field + currency validation]
  D --> E[Duplicate fingerprint]
  E --> F{Exceptions?}
  F -->|yes| G[Escalate to Governance]
  F -->|no| H[Ledger row]
  G --> H""",
        "limits": [
            "Text in, no OCR or vision stage. Feed it text extracted upstream.",
            "Single currency per document; no FX conversion.",
            "The duplicate fingerprint is exact — a re-issued invoice with a changed number is not caught.",
        ],
    },
    "07": {
        "oneline": "Natural-language questions over a warehouse where the model never writes SQL.",
        "does": [
            "The model emits a query spec: metric names, dimensions, filters, a date range and a limit.",
            "Every name is validated against a fixed registry, and anything unknown is discarded.",
            "SQL is assembled from registry column names, with user values bound as `$1, $2, …` parameters.",
            "The compiled SQL and its parameters come back with every answer, so a result can be audited.",
            "The worst a prompt injection achieves is having its spec rejected.",
        ],
        "flow": """flowchart TD
  A[question] --> B[Model emits query spec]
  B --> C[Validate against registry]
  C --> D[Compile parameterised SQL]
  D --> E[Read-only execute]
  E --> F[Narrate rows]
  F --> G[Verify narration]""",
        "limits": [
            "The demo warehouse is an n8n Data Table with 90 synthetic rows; aggregation happens in memory.",
            "The registry covers four metrics and five dimensions. Anything outside it returns `unsupported`.",
            "No joins across tables.",
        ],
    },
    "08": {
        "oneline": "Prompts live in Git rather than inside workflow JSON, and every render reports "
                   "the blob SHA it came from.",
        "does": [
            "Fetches prompt files through the GitHub Contents API at any Git ref, defaulting to `main`.",
            "Validates the caller's variables against the prompt's declared contract before interpolating.",
            "Refuses a prompt with an unfilled `{{placeholder}}` rather than sending it to a model.",
            "Returns the blob SHA, so an execution log ties back to exact prompt bytes.",
            "On a GitHub outage returns a bundled fallback flagged `degraded: true` — never silent non-Git text.",
        ],
        "flow": """flowchart TD
  A[prompt id + ref] --> B[GitHub Contents API]
  B -->|ok| C[Parse front matter]
  B -->|outage| D["Bundled fallback<br/>degraded: true"]
  C --> E[Validate variables]
  E --> F[Rendered prompt + blob SHA]
  D --> F""",
        "limits": [
            "The anonymous GitHub API allows 60 requests/hour per IP. Add a token for heavy use.",
            "No caching layer: every render is a live fetch.",
            "Bundled fallbacks exist for two hot-path prompts, not all twelve.",
        ],
    },
    "09": {
        "oneline": "Deterministic checks first; an LLM judge is one weighted signal, never the "
                   "whole verdict.",
        "does": [
            "Checks JSON Schema conformance, required fields, arithmetic rules, citation existence and safety markers.",
            "Decomposes the remaining prose into checkable claims, dropping headings and list lead-ins.",
            "Only then asks a model to label claims SUPPORTED, CONTRADICTED or NOT_STATED, in one batched call.",
            "Caps the judge at 40% of the score, and only when it actually ran.",
            "Degrades a failed or malformed judge to 'not evaluated' with `verified: false` — not a silent pass.",
        ],
        "flow": """flowchart TD
  A[output + sources] --> B[Schema · fields · arithmetic]
  B --> C[Citation existence]
  C --> D[Safety markers]
  D --> E{Sources supplied?}
  E -->|no| G[Verdict]
  E -->|yes| F[Claim entailment<br/>max 40% of score]
  F --> G""",
        "limits": [
            "At most 15 claims per call; beyond that `claims_truncated` is reported.",
            "The JSON Schema validator is a documented subset, not a full implementation.",
            "Groundedness quality depends on the judge model.",
        ],
    },
    "10": {
        "oneline": "Webhook to speech, with intent classification against a closed registry and a "
                   "gate before anything can act.",
        "does": [
            "Transcribes with Whisper, or accepts a text payload for testing.",
            "Classifies against a closed registry of five intents; an invented name becomes `unsupported`.",
            "Reads whether an intent changes data from the registry, not from the model.",
            "Sends data-changing intents to Governance and records the decision — it never executes them.",
            "Measures latency per stage, so the slow step is visible rather than averaged away.",
        ],
        "flow": """flowchart TD
  A["webhook: audio or text"] --> B[Whisper transcribe]
  B --> C[Classify against<br/>closed intent registry]
  C --> D{Changes data?}
  D -->|yes| E[Governance<br/>recorded, not executed]
  D -->|no| F[Run restricted tool]
  F --> G[Compose reply]
  E --> G
  G --> H[Verify, then speak]""",
        "limits": [
            "The audio upload path is structurally validated but was not exercised end to end. Text-to-speech is.",
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
            out.append(n["name"])
    return out


def read_evidence(folder: Path) -> list[dict]:
    """One row per evidence file: headline result, link, and the file's own caveat."""
    rows: list[dict] = []
    for sub in ("tests", "benchmarks"):
        for f in sorted((folder / sub).glob("*.json")):
            data = json.loads(f.read_text(encoding="utf-8"))
            rel = f"{sub}/{f.name}"
            if "passed" in data and "total" in data:
                result = f"{data['passed']}/{data['total']} fixtures passed"
            elif data.get("runs"):
                result = f"{len(data['runs'])} recorded runs"
            else:
                result = "recorded run"
            rows.append({
                "result": result,
                "rel": rel,
                "exec": data.get("n8n_execution_id"),
                "note": data.get("note"),
            })

    # A folder with no suite still has evidence if it captured a real run verbatim.
    out = folder / "sample-output.json"
    if not rows and out.exists():
        data = json.loads(out.read_text(encoding="utf-8"))
        rows.append({
            "result": "1 recorded run",
            "rel": "sample-output.json",
            "exec": data.get("n8n_execution_id"),
            "note": data.get("_note"),
        })
    return rows


def render(entry: dict, folder: Path) -> str:
    num = entry["number"]
    d = DETAIL[num]
    wf = json.loads((folder / "workflow.json").read_text(encoding="utf-8"))
    calls = entry.get("calls") or []
    called_by = entry.get("called_by") or []

    p: list[str] = [f"# {num} — {TITLES[num]}", ""]
    p += [d["oneline"], ""]
    p += ["`Live tested` · [`workflow.json`](workflow.json)", ""]

    p += ["## What it does", ""]
    p += [f"- {b}" for b in d["does"]]
    p += [""]

    p += ["## Flow", "", "```mermaid", d["flow"], "```", ""]
    if calls:
        p += ["Calls " + ", ".join(f"{c} {SERVICE_NAMES[c]}" for c in calls) + ".", ""]
    if called_by:
        p += ["Called by " + ", ".join(called_by) + ".", ""]

    p += ["## Setup", ""]
    svc = entry.get("external_services") or []
    if svc:
        p += [f"- {s}" for s in svc]
    else:
        p += ["No credentials of its own beyond the shared services it calls."]
    p += [""]
    if entry.get("credential_note"):
        p += [entry["credential_note"], ""]
    triggers = trigger_names(wf)
    if triggers:
        p += ["Run it from " + " or ".join(f"`{t}`" for t in triggers) + ".", ""]
    p += ["Credentials and data tables: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)", ""]

    rows = read_evidence(folder)
    if rows:
        p += ["## Test evidence", ""]
        p += ["| Result | Raw output |", "| --- | --- |"]
        for r in rows:
            ref = f"[`{r['rel']}`]({r['rel']})"
            if r["exec"]:
                ref += f" · execution `{r['exec']}`"
            p += [f"| {r['result']} | {ref} |"]
        p += [""]
        for r in rows:
            if r["note"]:
                p += [r["note"], ""]

    p += ["## Limitations", ""]
    p += [f"- {lim}" for lim in d["limits"]]
    p += [""]

    return "\n".join(p).rstrip() + "\n"


def main() -> int:
    written = 0
    for entry in CATALOG["workflows"]:
        folder = ROOT / "workflows" / entry["folder"]
        (folder / "README.md").write_text(render(entry, folder), encoding="utf-8")
        print(f"wrote {entry['folder']}/README.md")
        written += 1
    print(f"\n{written} README(s) written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
