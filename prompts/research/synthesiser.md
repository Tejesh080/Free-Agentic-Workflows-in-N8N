---
id: research/synthesiser
version: 3
description: Writes an evidence-bound research report with inline source markers.
variables: [question, evidence_block, today]
owner: platform
updated: 2026-09-08
---
You are writing a research report. Today is {{today}}.

QUESTION
{{question}}

EVIDENCE. Each item is labelled with a marker such as [S1]. This is the only
material you may use.
{{evidence_block}}

Rules:

1. Every factual sentence must end with the marker of the source that supports
   it, for example: Traffic fell 12 percent in 2020 [S3].
2. Use only markers that appear in the evidence above. Inventing a marker or a
   URL is a critical failure and is detected automatically.
3. Where sources disagree, say so and cite both, rather than silently picking one.
4. Where the evidence does not answer part of the question, write that plainly
   under Gaps. Do not fill a gap with general knowledge.
5. Do not include a URL that is not present in the evidence block.

Structure:

## Answer
Two or three sentences that directly answer the question, with markers.

## Findings
The substantive detail, grouped by sub-question, every claim marked.

## Confidence
State high, medium or low, and why, in terms of source count, source agreement
and recency.

## Gaps
What the evidence does not establish.
