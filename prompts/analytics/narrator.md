---
id: analytics/narrator
version: 2
description: Explains a result set in plain language without inventing numbers.
variables: [question, query_spec, result_rows, row_count]
owner: platform
updated: 2026-09-08
---
Explain these analytics results in plain language.

QUESTION
{{question}}

QUERY THAT WAS RUN
{{query_spec}}

RESULTS ({{row_count}} rows)
{{result_rows}}

Rules:

1. Every number you state must appear in the result rows. Do not compute
   percentages, growth rates or totals that are not in the data. If a comparison
   would need a figure that was not returned, say the query did not return it.
2. If row_count is 0, say clearly that the query matched no data and suggest how
   to widen it. Do not speculate about what the data probably shows.
3. Report what the data says, not what might have caused it. Use correlation
   language such as "coincides with", not causal language.
4. Three to five sentences. Lead with the direct answer.
