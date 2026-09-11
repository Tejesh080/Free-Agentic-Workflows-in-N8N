# Architecture

## The one-sentence version

A deterministic revenue pipeline in which a language model is used for exactly
one thing — turning unstructured text into labels from a closed set — and every
consequential decision downstream is arithmetic, policy, or a person.

## Layers

```
        inbound lead (webhook, sub-workflow, manual)
                        |
        +---------------v----------------+
        | 14 Revenue Swarm Orchestrator  |   sequence only, no judgement
        +---------------+----------------+
                        |
    +-------------+-----+------+--------------+
    |             |            |              |
+---v----+   +----v-----+  +---v-----+   +----v------+
| 12     |   | 11 CRM   |  | 13      |   | 15 Eval   |
| Qualify|   | Sync     |  | Outreach|   | Harness   |
+---+----+   +----+-----+  +---+-----+   +----+------+
    |             |            |              |
    |             |            |              |
+---v-------------v------------v--------------v-----+
| 02 Model Router   05 Governance/HITL              |
| 08 Prompt Registry 09 Verification                |
+---------------------------+------------------------+
                            |
              HubSpot  ·  Firecrawl  ·  Telegram  ·  model providers
```

Nothing in the top two layers talks to an external system directly. Every
HubSpot call in the entire platform happens inside three nodes in `11`, and
those nodes ship disabled.

## What decides what

This is the part that matters, and it is the part most "AI agent" systems get
wrong by handing the whole chain to a model.

| Decision | Decided by | Why |
| --- | --- | --- |
| What the lead text *says* | **LLM**, constrained to a closed enum set + a verbatim quote per label | Reading unstructured prose is the one thing a model is genuinely better at |
| Whether a quoted piece of evidence is real | **Deterministic** substring check against the source text | A model asked to check its own citation will agree with itself |
| The lead's score | **Deterministic** weighted rubric over the labels | Same lead, same number, every time; every point traceable to a component |
| Tier and routing | **Deterministic** thresholds | A threshold is a business decision, not an inference |
| Whether signals are in contract | **Deterministic** schema + a second service (`09`) | Out-of-contract labels score zero rather than being guessed at |
| Whether outreach copy is acceptable | **Deterministic** rules (length, banned phrases, ungrounded figures, placeholder leaks) | Cheap, instant, and cannot be talked out of its opinion |
| Whether a drafted claim is supported | **Second model** via `09`, capped at 40% of the verdict | Useful signal, never the whole verdict |
| Whether to send to a real person | **Human**, via `05` (`send` = HIGH risk) | Irreversible and outward-facing |
| Whether a rubric change ships | **Arithmetic** over labelled outcomes (`15`) | The one place a self-improving system would silently drift |
| Which model runs a task | **Deterministic** scoring over quality/cost/latency with hard gates (`02`) | Routing is an optimisation problem, not a judgement call |

Two rules follow from the table, and they are the spine of the design:

1. **The model never produces a number that anything acts on.** It produces
   labels. Numbers come from the rubric.
2. **Nothing irreversible happens without either a deterministic proof or a
   person.** The CRM write has an idempotency ledger; the send has a human.

## Agent boundaries, and why there are only four

An agent here is a service with its own contract, its own failure mode, and its
own test suite — not a prompt with a job title.

- **12 Qualify** — reads the lead, produces labels + a score.
- **11 CRM Sync** — the only thing that writes to a CRM.
- **13 Outreach** — drafts, checks, and asks permission.
- **14 Orchestrate** — sequences the above and records what happened.

A "Research Agent", "Enrichment Agent", "Routing Agent", "Follow-up Agent" and
"Outcome Learning Agent" were all considered and rejected as separate agents.
Enrichment is one scrape call. Routing is four `if` statements. Follow-up is a
scheduler. Outcome learning is `15`, and it is deliberately not an agent — it is
a spreadsheet with a gate. Splitting these out would multiply the failure
surface, the latency and the cost, and buy nothing a reader could point at.

## Multi-tenancy

Every service takes `tenant_id`, validated against `^[a-z0-9][a-z0-9_-]{0,62}$`
— restricted rather than escaped, because a tenant id that can smuggle a
separator into a composite key can address another tenant's rows.

Tenancy is enforced at three points:

- **Idempotency keys** are prefixed with the tenant, so two workspaces sending
  the same lead do not collide in the CRM write ledger.
- **Ledger lookups** filter on `tenant_id` as well as the business key.
- **Every response** echoes the tenant, including the duplicate-suppression and
  rejection paths, so a caller can always correlate an answer to a workspace.

Fixtures `C08`/`C08x` in `11` and `S07`/`S07x` in `14` fail if cross-tenant
suppression ever returns. That is the test that matters: before this change, one
tenant's lead silently returned another tenant's CRM object id.

## Correlation and the decision receipt

`14` mints a `trace_id` per lead and threads it through every service. Every
service echoes it, including on paths that produce nothing.

Each run writes one row to `swarm_decision_receipts`: score, tier, confidence,
the full scoring breakdown, CRM object ids, outreach status, governance decision
and risk level, model providers, rubric version, latency, and the ordered step
list with a reason for each step that did not run.

That row is the unit a lead page and an agent trace read from. The dashboard
described in the roadmap is a renderer over this table — it does not need to
understand n8n, and it does not need a second source of truth.

## Data model

| Table | Grain | Purpose |
| --- | --- | --- |
| `swarm_decision_receipts` | one run | the auditable record of one lead's journey |
| `swarm_lead_ledger` | one lead per tenant | dedupe and the current state of a lead |
| `swarm_crm_writes` | one CRM write | idempotency; checked *before* the CRM, not after |
| `swarm_outreach_log` | one outreach attempt | including the blocked ones, with the stage that stopped them |
| `swarm_eval_runs` | one evaluation | rubric comparison and the promotion verdict |

These are n8n Data Tables today. They are modelled as relational tables with a
tenant column precisely so the move to Postgres is a migration and not a
redesign — see [ROADMAP.md](ROADMAP.md) Stage B.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Prompt registry unreachable | bundled fallback carrying the same value contract; marked `degraded` |
| Model returns unparseable JSON | score capped at 40, `requires_human_review` set |
| Model returns out-of-contract labels | those components score zero, capped at 45, named in the verdict |
| A quote is not in the source text | −10 points, outreach blocked, human review |
| A candidate rubric is malformed | production rubric used, error surfaced in the verdict |
| Scrape fails | qualification continues without enrichment, recorded as such |
| Governance times out or replies oddly | resolves to rejected |
| Same lead twice | ledger replay, no second CRM object |
| Ingest key unset | every inbound lead refused |

The pattern throughout: fail toward *doing less*, and say so in the record.
