# 05 Agent Governance and HITL

> Deterministic LOW/MEDIUM/HIGH/CRITICAL risk classification, policy validation, Telegram approval and deny-by-default for CRITICAL operations.

**Status:** LIVE VERIFIED · **24 nodes** (21 executable) · n8n workflow `G3OIbtaw2z11zIxP` on the instance it was built and tested on

## The problem

Agents that can act need a decision layer that is auditable and that fails closed. Asking a model whether an action is safe is not that layer.

## How it works

1. Classify risk **deterministically** from the action type, then raise it on destructive verbs, production targets, monetary amounts, bulk operations, personal data in parameters, low agent confidence, and injection-shaped reasoning.
2. LOW executes. MEDIUM runs five deterministic policy checks and executes only if all pass. HIGH goes to a human. CRITICAL is denied by default.
3. Send HIGH and CRITICAL to Telegram and wait, with a 60 minute limit.
4. Record every decision with its reasons, the decider and an expiry.

## Platform services it calls

None — this *is* a platform service.

Called by: **01**, **06**, **10**

## Safety properties

Levels can only ever be raised, never lowered. An unrecognised action type defaults to **HIGH**, not LOW. A timeout, channel error or malformed response all resolve to **rejected**. A request whose own text argues it is pre-approved is treated as a suspected injection and raised to CRITICAL. Simulated decisions used by tests are written to the ledger as `simulated:test-harness` so they can never be mistaken for real approvals.

## Triggers

- `Governance Request`
- `Test Suite Trigger`

## Verification

- **12/12 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json) (n8n execution `187`)
  - Risk classification, routing, policy validation and the deny-by-default rule are fully exercised. The Telegram approval leg is NOT exercised here; ledger rows from this suite carry decided_by='simulated:test-harness' so they can never be mistaken for real human approvals.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- Telegram (human approval channel, optional for testing)

The classification engine and all four risk tiers are testable with no credentials via simulate_decision. Only the real human-approval leg needs a Telegram bot and chat id.

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- The Telegram approval leg is not covered by the automated suite; the 12 fixtures use `simulate_decision`.
- The MEDIUM allow-list of target systems is a demo list and must be replaced for real use.
- Approvals are not cryptographically signed.

## Import

```bash
python scripts/import-workflows.py --only 05
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
