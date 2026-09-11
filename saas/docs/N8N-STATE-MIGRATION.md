# n8n state: inventory, classification, and the cutover that has not happened

Read this before believing that Postgres is authoritative. **Right now it is not
— there are two stores holding the same facts, and neither has been retired.**
That is a deliberate intermediate state, but it is a state with a cost, and this
document is where the cost is written down rather than discovered later.

## Inventory

Every data table on the shared n8n instance, as of 2026-09-12. Classification is
the point: only one class needs to move.

### Revenue Swarm (workflows 11–16)

| Table | Id | Class | Postgres counterpart |
| --- | --- | --- | --- |
| `swarm_lead_ledger` | `t5Vf1eYu6ZvLskng` | **Authoritative product state** | `leads` |
| `swarm_decision_receipts` | `IP16E2c5vXkbkd92` | **Authoritative product state** | `decision_receipts` |
| `swarm_outreach_log` | `gNpi9lbtegHCjNqI` | **Authoritative product state** | `decision_receipts.actions_taken`, `approval_requests` |
| `swarm_eval_runs` | `SDwCu8WtMqVMOoDR` | **Authoritative product state** | `evaluation_runs` |
| `swarm_failures` | `lHIAS3pABYhoV20f` | **Authoritative operational state** | none yet — see below |
| `swarm_crm_writes` | `unmBMYafk83UUkeK` | Execution-local idempotency | stays in n8n — see below |

### Shared platform services (workflows 02, 05, 09)

| Table | Id | Class | Note |
| --- | --- | --- | --- |
| `agentic_governance_decisions` | `ALeKjGvwnCozDFlL` | Authoritative, **but not only ours** | Workflows 01 and 10 also use it. Revenue Swarm must stop depending on it; the table itself stays for them. |
| `agentic_router_telemetry` | `LdqKndA7aAPelkQj` | System trace / observability | Stays. Which provider was picked and how long it took is engine telemetry, not product state. |
| `agentic_verification_log` | `i02zlZrfRX2z2Sea` | System trace / observability | Stays, same reasoning. The *verdict* is copied into the receipt; the log is the engine's own record. |

### Unrelated to this product

`agentic_invoice_ledger`, `agentic_analytics_demo` (workflows 06 and 07), and
`ebias_trades` (a different project on the same host). Untouched.

**No ARIE data table exists on this instance**, and nothing in workflows 11–16
references one. Sharing the n8n host with ARIE is hosting, not coupling.

## The split-brain, stated plainly

Building the control plane created a second home for four kinds of fact:

| Fact | Written by n8n to | Written by the control plane to |
| --- | --- | --- |
| a lead and its tier | `swarm_lead_ledger` | `leads` |
| a decision receipt | `swarm_decision_receipts` | `decision_receipts` |
| an outreach attempt | `swarm_outreach_log` | `decision_receipts.actions_taken` |
| an evaluation run | `swarm_eval_runs` | `evaluation_runs` |

Today these do not actually diverge, for a boring reason: **nothing has driven a
lead through both paths yet.** The engine's tables are populated by its own test
suites; Postgres is populated by the control plane's seed and by the callback
handler. The dispatch hop between them has never run against a live n8n webhook.

That is the least bad version of this problem — no production data is
inconsistent, because there is no production data. But it will stop being the
least bad version the moment a real lead is ingested, so the cutover has a
deadline that is *before* first real use, not after.

## The cutover

Ordered, and each step independently verifiable. None of it has been done.

**1. Make the callback the only writer of authoritative state.**

The engine currently writes its own ledger rows *and* reports them in the
callback. Remove the writes, keep the reporting. Concretely, in workflow 14:
`Record Lead Ledger`, `Record Decision Receipt` and 13's `Record Outreach`
become no-ops, and their content moves into the callback payload — where most of
it already is.

Verify: run the 14 suite. It asserts `decision_record_complete` and
`rubric_recorded` from the returned record, not from the table, so it should stay
green. If it goes red, the assertion was reading the database and needs to read
the result.

**2. Keep `swarm_crm_writes` where it is, and say why.**

This one is not a candidate for migration, and it is worth being explicit because
"move all state to Postgres" would sweep it up by accident.

It is checked *synchronously, inside the CRM adapter, immediately before the
HubSpot call*, to suppress a duplicate write. Moving it to Postgres would put a
network round trip between the idempotency check and the operation it guards —
widening exactly the window it exists to close, and adding a failure mode where
the check is unreachable but the CRM is.

It is a cache with a correctness role, local to the operation it protects. What
Postgres holds instead is the authoritative record of what was written:
`decision_receipts.crm_result` and `actions_taken`. Those are the audit; the
ledger is a lock.

**3. Give the dead-letter queue a Postgres home.**

`swarm_failures` has no counterpart and should get one, because a failed run is
product state a customer needs to see. The schema is in the table already
(`trace_id`, `node_name`, `error_message`, `execution_url`, `replay_payload`,
`replayable`, `replayed_at`, `replay_execution_id`), and the natural shape is a
`dead_letters` table keyed on `trace_id` with a foreign key to `executions`.

Not built. `executions.status` has a `dead_letter` value reserved for it, and
`executions.error` and `executions.replay_of` already carry the rest, so this may
turn out to be a view rather than a table. Deciding that needs the replay path
running against Postgres, which needs step 1.

**4. Move Revenue Swarm's approvals off `agentic_governance_decisions`.**

Workflow 13 asks the shared governance service, which stores its decision in that
table and notifies Telegram. The control plane now owns approval state, with a
state machine the database enforces. These are two systems that both believe they
own the answer.

The target: 13 reports `approval.required` in the callback and stops. The control
plane creates the `approval_requests` row, a human decides in the dashboard, and
the continuation dispatch (`docs/CONTRACTS.md` §4) performs the action. The
shared governance service keeps serving workflows 01 and 10, which is what it was
built for.

This is the largest of the four, and it is the one that removes Telegram from the
authorization path.

**5. Dual-read, verify, then delete.**

Only after 1–4: for one window, read both stores and compare; then stop reading
n8n's; then drop the four superseded tables. Not before — the handoff's
instruction not to delete n8n state until the Postgres replacement has proven
equivalent behaviour is the right instruction, and nothing here has proven it
yet.

## What "authoritative" will mean when this is finished

| Question | Answered by |
| --- | --- |
| Why was this lead scored 87? | Postgres: `decision_receipts`, `lead_evidence` |
| What is this lead's current tier? | Postgres: `leads` |
| Who approved the send, and when? | Postgres: `approval_requests`, `audit_events` |
| Did the CRM write already happen for this key? | n8n: `swarm_crm_writes` (a lock, checked in-line) |
| What did the CRM write produce? | Postgres: `decision_receipts.crm_result` |
| Which provider served the call, and what did it cost? | n8n: `agentic_router_telemetry`; summarised into `executions` |
| Was the output verified? | Postgres: `decision_receipts.verification`; engine detail in `agentic_verification_log` |
| Which run failed, and can it be replayed? | Postgres, once step 3 is done. n8n today. |

Three stores, three questions — the business trace, the system trace and the
audit log — correlated by `trace_id`. Not one giant JSON table pretending to be
all three.
