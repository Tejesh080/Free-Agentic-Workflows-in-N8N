# Connections

One checklist. Work top to bottom; everything marked optional can wait.

## Summary

| Service | Why it is needed | Used by | Required? | How to connect |
| --- | --- | --- | --- | --- |
| **n8n instance + API key** | Runs the workflows; the key is only for the import/export scripts | all | **Required** for scripts | n8n → Settings → n8n API → Create an API key → put it in `.env` |
| **Google Gemini** | Fast/cheap tier in the Model Router; fallback tier | 02 → all | **Required** (one provider minimum) | Covered by n8n AI Gateway credits. Otherwise create a *Google Gemini (PaLM) API* credential |
| **OpenAI** | Balanced tier in the router; embeddings for RAG; Whisper and TTS for voice | 02, 03, 10 | **Required** for 03 and 10 | Covered by Gateway credits. Otherwise an *OpenAI* credential |
| **Anthropic** | Quality tier in the router | 02 | Optional but recommended | Covered by Gateway credits. Otherwise an *Anthropic* credential |
| **Firecrawl** | Live web search and scrape | 04 | **Required** for 04 | Covered by Gateway credits. Otherwise a *Firecrawl* credential |
| **GitHub** | Fetches versioned prompts at run time | 08 → 01, 03, 04, 06, 07, 10 | No credential for a public repo | Anonymous. Add a token only for a private prompt repo or to raise the rate limit |
| **Telegram** | Human approval channel | 05 | **Optional** | Create a bot with @BotFather, add a *Telegram* credential, then set the chat id (below) |
| **Qdrant** | Persistent vector store | 03 | **Optional** | Demo uses the in-memory store. For production swap the two vector store nodes and add a *Qdrant* credential |
| **Postgres** | Real analytics warehouse | 07 | **Optional** | Demo uses an n8n Data Table. For production swap *Read Analytics Rows* for a Postgres node on a **read-only role** |
| **Google Search Console** | Real analytics source | 07 | **Optional** | Not wired by default; the query compiler emits portable SQL you can adapt |

### If your n8n has AI Gateway credits

Gemini, OpenAI, Anthropic and Firecrawl nodes are assigned a managed credential
automatically on import. **You do not need any provider API keys.** That is how
every measured result in this repository was produced.

---

## 1. n8n API key (for the scripts)

```bash
cp .env.example .env
```

Set:

```
N8N_BASE_URL=https://your-instance.app.n8n.cloud
N8N_API_KEY=<key from Settings → n8n API>
```

`.env` is git-ignored. Verify the connection:

```bash
python scripts/n8n_api.py
```

---

## 2. Data tables (manual — 5 minutes)

The n8n public API does not expose data tables, so `import-workflows.py` cannot
create them. Create these in **n8n → Data tables**, then select each one in the
node the importer names.

Nodes will import and validate without them; they fail at run time if missing.

### `agentic_router_telemetry` — used by 02

`request_id` string, `source_workflow` string, `task_type` string,
`objective` string, `privacy` string, `selected_provider` string,
`selected_model` string, `fallback_used` boolean, `status` string,
`latency_ms` number, `tokens_in_est` number, `tokens_out_est` number,
`estimated_cost_usd` number, `error_message` string, `run_label` string

### `agentic_governance_decisions` — used by 05

`request_id` string, `requesting_workflow` string, `proposed_action` string,
`affected_system` string, `risk_level` string, `risk_reasons` string,
`confidence` number, `decision` string, `decided_by` string,
`decision_reason` string, `parameters_json` string, `expires_at` string,
`decided_at` string

### `agentic_verification_log` — used by 09

`request_id` string, `caller` string, `mode` string, `verified` boolean,
`score` number, `deterministic_score` number, `groundedness_score` number,
`issues_count` number, `issues_json` string, `requires_human_review` boolean,
`claims_total` number, `claims_supported` number, `latency_ms` number

### `agentic_invoice_ledger` — used by 06

`fingerprint` string, `invoice_number` string, `vendor_name` string,
`invoice_date` string, `currency` string, `total_amount` number,
`status` string, `confidence` number, `exceptions_json` string,
`first_seen_at` string, `execution_id` string

### `agentic_analytics_demo` — used by 07

`event_date` string, `property` string, `page` string, `query` string,
`country` string, `device` string, `clicks` number, `impressions` number,
`position` number

> **Do not create a column called `caller` on a table a Set node writes to.**
> n8n's Set node blocks assignments named `caller` as a reserved property and
> fails the node at run time. `agentic_verification_log` keeps the name only
> because nothing assigns to it directly.

Once `agentic_analytics_demo` exists, run workflow 07's **Seed Demo Warehouse**
trigger. It fetches the synthetic dataset from this repository and loads 90 rows.

---

## 3. Telegram approval channel (optional, for 05)

Only needed for the real human-approval leg. The risk classifier and all four
tiers are fully testable without it via the `simulate_decision` input, which is
what the 12-fixture suite uses.

1. Create a bot with [@BotFather](https://t.me/botfather), copy the token.
2. In n8n create a **Telegram** credential with that token.
3. Get your chat id by messaging [@get_id_bot](https://t.me/get_id_bot).
4. In n8n → Settings → Variables, add `GOVERNANCE_APPROVER_CHAT_ID` = your chat id.

Optionally set `GOVERNANCE_OVERRIDE_TOKEN` to replace the default
`ALLOW-CRITICAL-REVIEW`. That token does not approve anything — it only lets a
CRITICAL request reach a human instead of being denied outright.

---

## 4. Qdrant (optional, for 03)

The demo runs on n8n's in-memory Simple Vector Store, which needs no credentials
but does not survive a restart. For a persistent store:

1. Create a Qdrant instance (Qdrant Cloud has a free tier) and a collection.
2. In n8n create a **Qdrant** credential with the URL and API key.
3. Replace **Store Chunks** and **Retrieve Chunks** with
   `Qdrant Vector Store` nodes (insert and load modes respectively), keeping the
   same embedding sub-node and the same downstream connections.

Everything after retrieval — filtering, reranking, citation binding, the
no-answer path — is store-agnostic and needs no change.

> Embedding model note: the n8n AI Gateway returns **HTTP 404** for
> `gemini-embedding-001`. These workflows use OpenAI `text-embedding-3-small`,
> which the gateway does serve. If you switch models, re-ingest — vectors from
> different models are not comparable.

---

## 5. Postgres (optional, for 07)

Use a **read-only role**. The workflow never issues DDL or DML, and the
architecture assumes the database enforces that rather than trusting the agent.

```sql
CREATE ROLE analytics_readonly LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE your_db TO analytics_readonly;
GRANT USAGE ON SCHEMA public TO analytics_readonly;
GRANT SELECT ON analytics_events TO analytics_readonly;
```

Replace **Read Analytics Rows** with a Postgres node executing the
`compiled_sql` and `sql_parameters` the workflow already produces. Both are in
every response for exactly this reason, and they are what makes each answer
auditable.

---

## What is not wired

- **Google Search Console** as a live source for 07. The compiler emits portable
  SQL, but no GSC node is present.
- **ElevenLabs** for voice. 10 uses OpenAI TTS because it is covered by Gateway
  credits; swapping in ElevenLabs is one node.
- **A local model** (Ollama, vLLM) in the router. The candidate registry has a
  commented example and the privacy gate already refuses `privacy=local_only`
  rather than silently using a cloud provider — but no local branch is wired.
