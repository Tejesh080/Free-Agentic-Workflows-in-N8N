# 09 AI Output Verification Layer

> Deterministic-first verification: JSON Schema, required fields, arithmetic business rules, citation existence and safety markers, then optional claim-level entailment.

**Status:** LIVE VERIFIED · **19 nodes** (16 executable)

## The problem

'LLM judges LLM' is the standard answer to hallucination and it is not good enough on its own: it is slow, costs a model call, and is itself capable of being wrong.

## How it works

1. **Deterministic checks first, always.** JSON Schema conformance, required fields, arithmetic business rules, **citation existence** and safety markers (unfilled placeholders, refusals, echoed prompt injections).
2. Decompose remaining prose into checkable factual claims, dropping headings, list lead-ins and other document furniture.
3. Only then, and only if sources were supplied, ask a model to label each claim SUPPORTED, CONTRADICTED or NOT_STATED — one batched call through the Model Router.
4. Combine into `score = 0.6 x deterministic + 0.4 x groundedness`, and return a machine-readable verdict.

## Platform services it calls

- **02 Model Router**

Called by: **01**, **03**, **04**, **06**, **07**, **10**

## Safety properties

The judge can move at most **40%** of the score, and only when it actually ran. A judge that fails or returns malformed JSON degrades to 'not evaluated' rather than scoring zero — and `verified` is then **false**, because grounding was asked for and did not happen. Truncated judge responses are repaired by finding the longest balanced prefix.

## Triggers

- `Verification Request`
- `Test Suite Trigger`

## Verification

- **10/10 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json) (n8n execution `174`)
  - latency_ms_measured is MEASURED wall-clock time per verification call. F06 and F07 make a real model call through the Model Router; the other eight cases are fully deterministic and make no model call at all.

Every figure came from a run on a live n8n instance; the linked files are the raw results.

## Connections required

- None beyond the platform services above.

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- At most 15 claims per call; beyond that `claims_truncated` is reported.
- The JSON Schema validator is a documented subset, not a full implementation.
- Groundedness quality depends on the judge model.

## Import

```bash
python scripts/import-workflows.py --only 09
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
