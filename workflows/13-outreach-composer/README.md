# 13 — Outreach Composer

A message to a real person is a HIGH-risk action, so a human approves it.

`Live tested` · [`workflow.json`](workflow.json)

## What it does

- Drafts from the prompt registry through the Model Router, with the collected evidence as the only thing it may assert.
- Runs deterministic copy rules first: length per channel, placeholder leaks, banned phrases, links, and any figure that is not in the evidence.
- Refuses locally when a rule fails, so a draft with a fabricated number never becomes a question for a human.
- Classifies the send through Governance, which rates `send` HIGH and waits for approval. An operator can lower it to `write`, and that choice is recorded on every log row.
- Logs the outcome either way, including the stage a blocked message was stopped at.

## Flow

```mermaid
flowchart TD
  A[lead + qualification] --> B{outreach allowed?}
  B -->|no| X[Blocked, logged]
  B -->|yes| C[Draft via Router]
  C --> D[Copy rules]
  D -->|fail| X
  D -->|pass| E[Verify against evidence]
  E -->|fail| X
  E -->|pass| F[Governance]
  F -->|rejected| X
  F -->|approved| G{dry_run?}
  G -->|yes| H[Simulated]
  G -->|no| I[Send]
```

Calls 02 Model Router, 05 Governance, 08 Prompt Registry, 09 Verification.

Called by 14.

## Setup

- Telegram

Telegram is the only channel wired to a real credential, and it needs a chat id from the caller. Email and SMS are drafted and approved, then recorded as not configured.

Run it from `Outreach Request` or `Test Suite Trigger`.

Credentials and data tables: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Test evidence

| Result | Raw output |
| --- | --- |
| 10/10 fixtures passed | [`tests/results-2026-09-12.json`](tests/results-2026-09-12.json) · execution `981` |

Every stage a send can be stopped at. O09 proves the governance risk scan reads the draft text too, so copy offering to "delete" something is escalated to CRITICAL and denied; that false positive is deliberate. Re-run on this execution as a regression after the workflow 11 change; 13 reaches the CRM only through 11.

## Limitations

- Only Telegram can actually send. Email and SMS are drafted, checked and approved, then recorded as `channel_not_configured`.
- Governance scans the draft text as well as the operation, so copy offering to delete something is escalated to CRITICAL and denied. That false positive is deliberate.
- The banned-phrase list is a short opinionated one, not a style guide.
- The figure check allows meeting durations; every other number must appear in the evidence verbatim.
