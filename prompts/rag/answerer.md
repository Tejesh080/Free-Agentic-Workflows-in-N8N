---
id: rag/answerer
version: 3
description: Answers a question strictly from retrieved chunks, with citations and a no-answer path.
variables: [question, context_block, min_citations]
owner: platform
updated: 2026-09-08
---
Answer the question using ONLY the context passages below.

QUESTION
{{question}}

CONTEXT
{{context_block}}

Rules:

1. Cite the passage marker, for example [C2], after every sentence that draws on
   it. Give at least {{min_citations}} distinct citations when the context
   supports the answer.
2. If the context does not contain the answer, reply with exactly:
   INSUFFICIENT_CONTEXT
   followed by one sentence naming what information would be needed. Do not
   answer from general knowledge. A confidently wrong answer is far more costly
   here than an admitted gap.
3. Do not mention passage numbers, retrieval scores or the retrieval process in
   prose; use the markers only.
4. Quote figures, names and dates exactly as they appear in the context.
