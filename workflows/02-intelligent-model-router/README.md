# 02 Intelligent Model Router

> Deterministic LLM routing across Gemini, OpenAI and Anthropic with privacy and capability gates, cross-vendor fallback and measured latency telemetry.

**Status:** LIVE VERIFIED · **25 nodes** (22 executable)

## The problem

Hard-coding one model into every workflow makes cost, latency and provider outages someone else's problem later. Picking a model with a prompt makes the choice unauditable.

## How it works

1. Normalise the request and stamp a start time.
2. **Decision engine (no LLM).** Hard gates first: privacy locality, JSON-mode capability, minimum quality, context size. Then a weighted score over quality prior, blended token price and latency prior, using the weight profile for the requested objective.
3. Route to the winning provider's chain node.
4. On failure, retry three times with backoff, then route the **error output** to a different vendor.
5. Measure wall-clock latency, estimate tokens and cost, and write a telemetry row.

## Platform services it calls

None — this *is* a platform service.

Called by: **01**, **03**, **04**, **06**, **07**, **09**, **10**

## Safety properties

`privacy=local_only` is **refused** rather than silently downgraded to a cloud provider when no local candidate is registered. `force_provider` can bypass the capability gate — it can never bypass the privacy gate.

## Triggers

- `Router Request`
- `Benchmark Trigger`

## Verification

- **9 recorded run(s)** — [`benchmarks/provider-matrix-2026-09-08.json`](benchmarks/provider-matrix-2026-09-08.json)
  - latency_ms_* are MEASURED wall-clock times inside n8n and include network, provider queueing and retry time. estimated_cost_usd values are ESTIMATES from configured list prices with tokens approximated as characters/4; the n8n LangChain chain nodes do not surface provider-reported token counts.

Every figure came from a run on a live n8n instance; the linked files are the raw results.

## Connections required

- Google Gemini
- OpenAI
- Anthropic

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- Quality priors and prices in the registry are **configured values, not measurements**. Re-check prices before trusting a cost figure.
- Token counts are estimated from characters/4; the n8n LangChain chain nodes do not surface provider-reported usage.
- No local provider is wired. The registry has a commented example.

## Import

```bash
python scripts/import-workflows.py --only 02
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
