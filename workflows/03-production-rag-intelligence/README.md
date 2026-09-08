# 03 Production RAG Intelligence Platform

> Ingestion to grounded answer: chunking with metadata, embeddings, vector storage, metadata-filtered retrieval, deterministic hybrid reranking, citation-bound generation, verification and an explicit no-answer path.

**Status:** LIVE VERIFIED · **27 nodes** (24 executable) · n8n workflow `BpvCMNOhjklm0YF5` on the instance it was built and tested on

## The problem

Most RAG demos retrieve the nearest chunks and let the model talk. That produces confident answers from irrelevant context, ignores document access rules, and gives no way to tell a good retrieval from a bad one.

## How it works

1. **Ingest**: chunk at 700 characters with 120 overlap, attaching `doc_id`, `title`, `category`, `audience` and `effective_from` as metadata, embed and store.
2. **Retrieve** the top-k chunks for the question.
3. **Filter on metadata** — an `internal` document is never returned to a `public` caller, even when it is the best semantic match.
4. **Rerank**: `0.7 x normalised vector score + 0.3 x lexical term overlap`. Deterministic, free, and it rescues exact-term matches that embeddings rank low.
5. **Gate on relevance** — being the closest thing in the store does not make a chunk evidence.
6. Generate with the `rag/answerer` prompt, requiring `[C#]` citations, then verify the answer against the retrieved chunks.

## Platform services it calls

- **02 Model Router**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

Audience filtering is access control, applied before the model sees anything. Test fixtures R03 and R04 ask the *same question* with different audiences to prove the filter is what blocks the answer, not retrieval luck.

## Triggers

- `Ingest Corpus`
- `RAG Query`
- `Test Suite Trigger`

## Verification

- **5/5 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json) (n8n execution `377`)
  - R03 and R04 ask the SAME question with different audiences. That pairing is what makes the access-control result meaningful: proving a document is blocked only means something if you also prove it would otherwise have been returned.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- OpenAI embeddings
- Qdrant (optional, production swap)

Runs credential-free on the in-memory Simple Vector Store. Qdrant is the documented production swap and needs QDRANT_URL and QDRANT_API_KEY.

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- The demo uses n8n's in-memory Simple Vector Store, which does not survive a restart. Qdrant is the documented production swap.
- Retrieval quality has not been measured against a labelled ground-truth set. The fixtures prove behaviour, not ranking quality.
- The corpus is eight invented documents.

## Import

```bash
python scripts/import-workflows.py --only 03
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
