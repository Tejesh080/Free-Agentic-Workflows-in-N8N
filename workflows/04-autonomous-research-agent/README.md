# 04 Autonomous Research Agent

> Plans a question into sub-questions, searches the live web, deduplicates evidence by URL and content shingles, synthesises a cited report, and verifies every claim against the retrieved sources.

**Status:** LIVE VERIFIED · **21 nodes** (18 executable)

## The problem

Research agents are the easiest place for an LLM to fabricate a citation, because a plausible URL looks like evidence.

## How it works

1. Plan the question into sub-questions and keyword queries using the `research/planner` prompt.
2. Run each query against live web search and collect results.
3. **Deduplicate** in two stages: exact match on a normalised URL (tracking parameters, `www.`, fragments and trailing slashes stripped), then near-duplicate detection using 3-word shingles with a Jaccard threshold of 0.8.
4. Synthesise a report with the `research/synthesiser` prompt, requiring an `[S#]` marker after every factual sentence.
5. Verify every claim against the collected evidence, and build a provenance map of what was cited, what was collected but unused, and any invented marker.

## Platform services it calls

- **02 Model Router**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

If every search returns nothing the agent stops and reports a gap. It never writes an unsourced answer. Fabricated markers and URLs are detected by string matching against the sources actually retrieved.

## Triggers

- `Research Request`
- `Demo Trigger`

## Verification

- **2 recorded run(s)** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json)
  - Live web results change over time, so the exact sources and figures will differ on a re-run. What is asserted here is structural: sources were retrieved and deduplicated, the report cited only real markers, and every claim was checked against the retrieved evidence.

Every figure came from a run on a live n8n instance; the linked files are the raw results.

## Connections required

- Firecrawl (web search and scrape)

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- Live web results change, so a re-run will cite different sources.
- The entailment judge evaluates at most 15 claims per call; longer reports report `claims_truncated`.
- No source-quality weighting: a blog and a primary regulator carry equal weight.

## Import

```bash
python scripts/import-workflows.py --only 04
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
