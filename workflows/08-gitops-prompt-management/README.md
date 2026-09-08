# 08 GitOps Prompt Management

> Fetches versioned prompts from GitHub at run time, validates declared variables, interpolates, and returns the blob SHA so every model call is traceable to exact prompt bytes.

**Status:** LIVE VERIFIED · **12 nodes** (10 executable) · n8n workflow `aYVpA31jgNL0shma` on the instance it was built and tested on

## The problem

Prompts embedded in workflow JSON cannot be reviewed, diffed, versioned or rolled back, and there is no way to tell which prompt text produced a given output.

## How it works

1. Resolve the prompt path and Git ref, defaulting to `main`.
2. Fetch the file through the GitHub Contents API, retrying three times with backoff and treating a 404 or rate limit as data rather than a crash.
3. Parse the front matter, validate the caller's variables against the prompt's declared contract, and interpolate.
4. Return the rendered prompt with its **blob SHA**, so an execution log ties back to exact prompt bytes.

## Platform services it calls

None — this *is* a platform service.

Called by: **01**, **03**, **04**, **06**, **07**, **10**

## Safety properties

In strict mode a prompt with an unfilled `{{placeholder}}` is refused rather than sent to a model, because models handle a literal placeholder unpredictably. On a GitHub outage the service returns a **bundled fallback** for hot-path prompts with `degraded: true` and an explicit issue, so a caller can never silently run on non-Git text believing it came from Git.

## Triggers

- `Prompt Request`
- `Test Suite Trigger`

## Verification

- **7/7 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json) (n8n execution `200`)
  - latency_ms_measured includes the GitHub round trip. Cases that hit the local cache path (P02, P03, P07 reuse an already-fetched blob within the same GitHub edge cache window) are visibly faster; that is real, not smoothed.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- GitHub Contents API (anonymous)

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- Anonymous GitHub API is 60 requests/hour per IP. Add a token for heavy use.
- No caching layer: every render is a live fetch.
- Bundled fallbacks exist for two hot-path prompts, not all twelve.

## Import

```bash
python scripts/import-workflows.py --only 08
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
