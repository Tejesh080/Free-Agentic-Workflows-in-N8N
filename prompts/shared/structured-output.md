---
id: shared/structured-output
version: 2
description: Appended when a caller needs a strict JSON response with no prose.
variables: [schema_description]
owner: platform
updated: 2026-09-08
---
Respond with raw JSON only.

- No markdown code fences, no prose before or after, no explanation.
- The response must be a single JSON value that parses on the first attempt.
- Use `null` for a value you cannot determine. Never write the string "unknown",
  never guess, and never omit a required key.
- Numbers must be JSON numbers, not strings, and must not contain thousands
  separators or currency symbols.

Required shape:

{{schema_description}}
