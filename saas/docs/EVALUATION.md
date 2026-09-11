# Evaluation: the gate, and the path to a dataset that can carry a claim

## What exists

Workflow 15 scores a labelled golden set under two rubrics — the published one
and a candidate — through the real qualification workflow, then applies a
deterministic promotion gate.

The most recent run (n8n execution `718`, 12 cases):

| Metric | Production `1.2.0` | Candidate `2.0.0` | Delta |
| --- | --- | --- | --- |
| Tier accuracy | 0.917 | 0.833 | −0.084 |
| HOT precision | 1.000 | 0.667 | −0.333 |
| HOT recall | 1.000 | 1.000 | — |
| HOT conversion | 1.000 | 0.667 | −0.333 |
| Leads predicted HOT | 4 | 6 | — |

Gate: **reject**. Three regressions, no improvement on any tracked metric.

### Read the shape, not just the sign

HOT recall is unchanged. The candidate still finds every genuinely HOT lead in
the set. What it adds is two false positives — `G04` and `G06`, both WARM leads
it promotes to HOT, and both of which went `no_reply`.

So the candidate would be described, accurately, as *"surfacing more hot leads"*.
It does. The gate rejects it anyway, because "more HOT" is not a tracked metric
and precision is. That is the whole argument for having a gate: the persuasive
description of a change and its measured effect point in opposite directions.

## Why the current dataset cannot carry a statistical claim

Twelve cases. Two disagreements move precision by a third. There is no
confidence interval worth computing, no segment large enough to compare, and no
defence against the golden set having been written by the same person who wrote
the rubric.

What twelve cases *are* enough for:

- proving the gate mechanism works, end to end, through the real workflow
- catching a gross regression — which is exactly what happened here
- making the disagreements individually inspectable, which is how the rubric got
  better in the first place

What they are **not** enough for: any sentence containing "significantly".

## The path, and what must not change along it

| Stage | Size | What becomes possible | What it costs |
| --- | --- | --- | --- |
| Now | 12 hand-labelled | Gate mechanism; gross regressions | — |
| Next | ~50 hand-reviewed | Per-tier accuracy with a usable denominator; segment sanity checks | a day of labelling |
| Then | 100+, mixed real and labelled | Precision/recall per tier; the first defensible "this is better" | real leads through the pipeline |
| Later | hundreds, real outcomes | Conversion by tier, which is the only metric a customer actually cares about | time — outcomes arrive months after decisions |

**The case contract does not change across those stages.** A case is: lead
input, human label, and optionally a recorded outcome. Everything a larger
dataset adds — seeded sampling, segments, confidence intervals — is computed
*over* that contract, not by changing it. This matters because the migration that
breaks an evaluation dataset is the one that redefines a case.

What the schema already carries for the later stages and does not yet use:
`evaluation_runs.dataset_version`, `.sample_seed`, `.segment`. Present so that a
run remains reproducible once sampling starts mattering, absent from any
computation today.

## The closed loop, and the line it must not cross

```
decision ──▶ outreach ──▶ outcome recorded ──▶ evaluation ──▶ recommendation
                                                                    │
                                                      human reviews │
                                                                    ▼
                                                    publish (admin, governed)
```

`lead_outcomes` is append-only and carries `occurred_at` separately from
`created_at`, because evaluation needs to know *when* something became true, not
only that it is true.

**Outcomes never change production behaviour on their own.** Nothing reads
`lead_outcomes` and adjusts a weight. Outcomes feed evaluation; evaluation
recommends; promotion is a human admin action that the RLS policy refuses to a
machine principal, and that the immutability trigger prevents from rewriting a
published rubric in place.

That chain is enforced, not merely intended:

- a machine principal cannot insert a `rubric_versions` row (policy)
- a published rubric's `definition` and `version` cannot change (trigger)
- an archived rubric cannot be resurrected (trigger)
- only one rubric per organization can be published at a time (partial unique
  index)
- a rubric a decision cites cannot be deleted (foreign key `on delete restrict`)

Tested in `tests/ingest-governance.test.ts` under "rubric versioning".

## What became reproducible

Before: a score, and a rubric version recorded alongside it.

Now, every decision receipt carries the full set needed to re-derive it —
`rubric_version_id` (a foreign key to an immutable row, not a string that could
drift from what it names), `prompt_versions` as a map of prompt path to blob SHA,
`model_metadata` with provider, model and configuration, `score_components` as
the deterministic breakdown, and `verification` as the evidence check result.

The gap that remains: **the dataset version is not yet recorded on the
decision.** A receipt says which rubric and which prompts produced it, but not
which golden set was current when the rubric was promoted. That is one column
(`executions.dataset_version`) and it is not there, so "reproduce the evaluation
that justified this rubric" is currently a manual lookup rather than a join.
