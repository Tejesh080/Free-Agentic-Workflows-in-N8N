# Provenance, attribution and licensing

## Summary

Nothing in `workflows/` is a redistributed third-party workflow file.

This repository was built by studying a private archive of ~130 n8n workflow JSON
exports (community templates collected from various sources) and then **re-implementing
ten systems from scratch** with the n8n Workflow SDK. The archive itself is **not**
published here, and no source workflow JSON was copied into this repository.

That decision was deliberate. The archive's files carry markers showing they originate
from other people's n8n instances and template exports:

| Marker found in the archive | What it means |
| --- | --- |
| `meta.instanceId` hashes (11 distinct values across the 10 source files) | Exports from other operators' n8n instances |
| `credentials: { id: "aALuyzBGGfmdBzrU", name: "Google Sheets account 2" }` | Credential identifiers belonging to third parties |
| `pinData` on **all ten** source files | Captured runtime payloads, possibly real data |
| Author-identifiable email addresses and IMAP/SMTP credential names | Personal data of the original authors |
| No `LICENSE` file, no SPDX header, no license field in any JSON | **Redistribution rights are unknown** |

Because redistribution rights are unknown, publishing those files unchanged — or
publishing lightly edited derivatives under this repository's MIT licence — would be
wrong. The architectural ideas were used as input; the implementations here are new.

## What was taken from each source

"Taken" below means *concept or algorithmic approach*, not code. Every workflow in
`workflows/` was authored fresh: different node graph, different contracts, different
error handling, different persistence, and shared platform services that the originals
did not have.

| This repo | Source workflow studied | Idea carried forward | What is new here |
| --- | --- | --- | --- |
| 01 API Integration Engineer | *API Schema Extractor* (88 nodes, Apify + Qdrant + Google Sheets + Gemini) | Event-router sub-workflow pattern; RAG over API documentation; structured extraction of API operations | Deterministic OpenAPI parsing replaces LLM scraping; plan grounded against the real operation list; governance gate before any non-GET call; safe read-only probing |
| 02 Model Router | *Testing Multiple Local LLM with LM Studio* | Iterate models, time each call, record metrics to a sheet | Deterministic scoring engine with privacy/capability gates, reusable service contract, cross-vendor fallback, telemetry to a data table, reproducible benchmark harness |
| 03 RAG Platform | *Customer Insights with Qdrant, Python and Information Extractor* | Qdrant vector store; Python for numeric work; information extraction over retrieved payloads | Full ingest+query split, metadata filtering, deterministic reranking, citation provenance, no-answer behaviour, verification pass |
| 04 Research Agent | *Open Deep Research* (OpenRouter + SerpAPI + Jina) | Plan → query → fetch → extract → synthesise pipeline | Structured planning contract, evidence deduplication, claim-to-source provenance map, verification layer, explicit uncertainty instead of invention |
| 05 Governance | *Ask a human* + *Very simple Human in the loop … IMAP* | Escalate to a human when the agent is unsure | Risk classification engine (LOW/MEDIUM/HIGH/CRITICAL), reusable request contract, decision ledger with expiry, deny-by-default for CRITICAL |
| 06 Financial Documents | *Invoice data extraction with LlamaParse and OpenAI* | Parse invoice → structured extraction → append to a reconciliation sheet | Arithmetic reconciliation, duplicate fingerprinting against a ledger, confidence scoring, exception taxonomy, seven negative test fixtures |
| 07 Conversational Analytics | *AI Agent to chat with your Search Console Data* | NL question → agent → data tool → answer | Whitelisted metric/dimension registry; the model emits a *query spec*, never SQL; deterministic compiler; read-only execution |
| 08 GitOps Prompts | *Load Prompts from GitHub Repo and auto-populate n8n expressions* | Fetch prompt text from GitHub, substitute variables, fail if a variable is missing | Versioned prompt registry with front-matter, commit SHA returned with every render, bundled fallback on fetch failure, prompt linting in the repository |
| 09 Verification | *Detect hallucinations using bespoke-minicheck* | Split output into sentence-level claims, check each against the source, summarise | Deterministic checks first (schema, required fields, arithmetic, citation existence), LLM entailment only as one weighted signal, machine-readable verdict contract |
| 10 Voice Agent | *AI Voice Chat using Webhook, Memory Manager, OpenAI, Gemini & ElevenLabs* | Webhook → STT → LLM → TTS → respond with audio | Per-stage latency measurement, intent gating, restricted tool surface, governance for risky intents, verification before speaking |

## Attribution

The source archive did not include reliable author metadata — the bundled `.docx`
files describe workflows other than the ones they ship with, so no author name could
be established for any of the ten. Where the workflows are recognisable as public n8n
community templates, credit for the original ideas belongs to their respective authors
on [n8n.io/workflows](https://n8n.io/workflows) and the n8n community forum.

If you are the author of one of the source templates and would like explicit
attribution added or a design credited differently, please open an issue.

## Licence of this repository

The contents of this repository — workflow definitions, prompts, scripts and docs —
are original work and are released under the MIT licence (see `LICENSE`).

The MIT licence applies **only** to the files in this repository. It does not, and
cannot, extend to the third-party source templates that were studied, because those
were not copied here and their licences are unknown.

## Third-party services

The workflows call third-party APIs (Google Gemini, OpenAI, Anthropic, Firecrawl,
Qdrant and others depending on which you enable). Their terms of service and pricing
are yours to accept and pay for. See `docs/CONNECTIONS.md`.
