# 01 Autonomous API Integration Engineer

> Parses an OpenAPI specification deterministically, plans an integration, grounds every step against the real operation list, verifies the plan, gates write steps through Governance and safely probes read-only endpoints.

**Status:** LIVE VERIFIED · **25 nodes** (22 executable) · n8n workflow `VM0yQx7HzjTElxgg` on the instance it was built and tested on

## The problem

Reading an unfamiliar API and writing the first integration is slow, and an LLM asked to do it will confidently invent endpoints that do not exist.

## How it works

1. Fetch the OpenAPI document and parse it **deterministically** — servers, security schemes, every operation with its parameters, request body, response codes and read/write effect. No model is involved in this step.
2. Fetch the `api-integration/spec-analyst` prompt from the GitOps registry and ask the Model Router to plan an integration for the stated goal.
3. **Ground the plan**: every `operation_id` the model proposed must exist in the parsed operation list. Method, path and write effect are taken from the specification, never from the model, and disagreements are reported.
4. Verify the plan against a JSON Schema through the Verification Layer.
5. If the plan contains write steps, send them to Governance for a decision.
6. Probe read-only endpoints against the server the specification declares, and compare the live response fields to what the plan expected.
7. Emit an integration report with a six-point readiness verdict.

## Platform services it calls

- **02 Model Router**
- **05 Governance**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

Only GET and HEAD are probed, only against the specification's own base URL, and only where the path needs no invented identifier. **Write operations are never executed**, whether or not Governance approved them — the approval is recorded for a human.

## Triggers

- `Integration Request`
- `Demo Trigger`

## Sample input and output

- [`sample-input.json`](sample-input.json)
- [`sample-output.json`](sample-output.json) — a verbatim capture of a real run

## Verification

- **5 recorded run(s)** — [`benchmarks/demo-runs-2026-09-08.json`](benchmarks/demo-runs-2026-09-08.json)
  - latency_ms values are MEASURED wall clock. estimated_cost_usd comes from the Model Router and is an ESTIMATE from configured list prices.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- Any HTTP API described by an OpenAPI 3 document

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- JSON OpenAPI 3 only. YAML specifications are rejected with a clear message.
- `$ref` is not dereferenced, so response field checking uses observed keys rather than the resolved schema.
- The probe stage cannot exercise endpoints that require authentication.

## Import

```bash
python scripts/import-workflows.py --only 01
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
