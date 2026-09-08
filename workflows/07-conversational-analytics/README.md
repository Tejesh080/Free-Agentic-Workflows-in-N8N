# 07 Conversational Analytics Agent

> Natural-language analytics where the model never writes SQL: it emits a query spec validated against a metric and dimension registry, which a deterministic compiler turns into a parameterised read-only query.

**Status:** LIVE VERIFIED · **22 nodes** (19 executable) · n8n workflow `xTdqxbplj0oXmByi` on the instance it was built and tested on

## The problem

Letting an LLM write SQL against a warehouse is the fastest way to turn a prompt injection into a data breach.

## How it works

1. Load the metric and dimension registry — the security boundary.
2. Ask the model, via the `analytics/query-planner` prompt, for a **query spec**: metric names, dimension names, filters, a date range and a limit. Never SQL.
3. **Validate and compile deterministically.** Every name is checked against the registry and anything unknown is discarded. SQL is assembled from registry column names with user values bound as `$1, $2, ...` parameters.
4. Execute read-only, aggregate, then narrate the rows with the `analytics/narrator` prompt.
5. Verify the narration against the returned rows.

## Platform services it calls

- **02 Model Router**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

No model text ever reaches a query string. The worst a prompt injection can achieve is having its spec rejected. The compiled SQL and its bound parameters are returned in every response, so each answer is auditable.

## Triggers

- `Analytics Question`
- `Seed Demo Warehouse`
- `Demo Trigger`

## Sample input and output

- [`sample-input.json`](sample-input.json)
- [`sample-output.json`](sample-output.json) — a verbatim capture of a real run

## Verification

- No recorded run in this folder.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- Postgres (optional, production swap)
- Google Search Console (optional)

Ships with a synthetic demo warehouse in an n8n Data Table and needs no database credentials.

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- The demo warehouse is an n8n Data Table with 90 synthetic rows; aggregation happens in memory.
- The registry covers four metrics and five dimensions. Anything outside it returns `unsupported`.
- No joins across tables.

## Import

```bash
python scripts/import-workflows.py --only 07
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
