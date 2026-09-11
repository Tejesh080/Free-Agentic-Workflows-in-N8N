# Evaluation

The scoring rubric is the most consequential piece of logic in the system: it
decides who gets emailed and who gets a deal opened. So it is versioned, and it
is not changed on anybody's intuition.

`evals/golden/leads.json` holds labelled leads. Each one carries a tier assigned
by a person and the commercial outcome that actually followed. The labels are
the ground truth; the rubric is the thing being measured.

> ## What twelve leads do and do not prove
>
> This is an evaluation **framework**. The current run proves the machinery
> works: versioned rubrics, dual scoring through the real workflow, a gate that
> rejects a regression, and a disagreement list that names the rows.
>
> It does **not** establish that rubric `1.2.0` is production-optimal, or that
> its numbers would survive contact with real traffic. Twelve hand-labelled
> leads from one labeller is a smoke test for the method, not a measurement of
> the model. A 2-point move on this set is noise.
>
> The gate is trustworthy at any size — it is arithmetic. The *conclusions* only
> become trustworthy as the set grows.

[`15 Evaluation Harness`](../workflows/15-evaluation-harness/) scores the whole
set twice — once under the production rubric, once under a candidate — by
calling the real qualification workflow rather than a reimplementation of it.
Signals are supplied, so no model call is made and a run costs nothing.

## The promotion gate

    promote  =  no regression on any tracked metric
            AND at least one metric strictly better

Tracked: tier accuracy, HOT precision, HOT recall, and the conversion rate of
the leads a rubric calls HOT. A tie is not a promotion — if a candidate matches
production everywhere, there is nothing to gain by changing.

No model is asked whether the new rubric is better. That is precisely the
judgement a model is worst placed to make about its own output, and it is where
a self-improving system would quietly drift.

## Recorded result: `2.0.0-candidate` — rejected

The candidate lowers every tier threshold (HOT at 60 instead of 75) on the
theory that the system is too conservative and leaves pipeline on the table.

| Metric | Production `1.2.0` | Candidate `2.0.0` | |
| --- | --- | --- | --- |
| Tier accuracy | **0.917** | 0.833 | regressed |
| HOT precision | **1.000** | 0.667 | regressed |
| HOT recall | 1.000 | 1.000 | unchanged |
| HOT conversion | **1.000** | 0.667 | regressed |

Rejected: three regressions, no improvements. Execution `718`, raw output in
[`workflows/15-evaluation-harness/tests/`](../workflows/15-evaluation-harness/tests/).

What the aggregate hides, the disagreement list shows:

| Case | Human label | Production | Candidate | What happened |
| --- | --- | --- | --- | --- |
| G04 | WARM | WARM (69) | **HOT** (69) | no reply |
| G06 | WARM | WARM (63) | **HOT** (63) | no reply |
| G08 | COLD | **DISQUALIFIED** (23) | COLD (23) | no reply |

The candidate buys one correct answer (G08) and pays for it with two false HOTs.
Both of those are leads it would have emailed and opened a deal for, and neither
ever replied. "Be less conservative" is a reasonable hypothesis; on this evidence
it is wrong, and the gate says so with the rows to back it up.

G08 is the honest residue: a person would keep a tiny no-budget company in
nurture, and production bins it. That is a real disagreement worth fixing — but
by changing the small-company band, not by loosening every threshold.

## Growing the set: 12 to 50 to thousands

The schema is designed so this scales without redesigning anything. A case is
`{case_id, expected_tier, outcome, lead, signals}` and nothing about the harness
cares how many there are or where they came from.

| Size | Source of labels | Storage | What changes | What does not |
| --- | --- | --- | --- | --- |
| **12** (now) | hand-labelled | `leads.json`, mirrored into workflow 15 | — | — |
| **~50** | hand-labelled from real inbound | same | nothing; the loop is already per-case | schema, gate, metrics |
| **~100–500** | real leads with CRM outcomes attached | `leads.json` gets large; move it to a Postgres `golden_cases` table and have 15 read a **stratified sample** | the loader node, and a `sample_size` / `seed` input for reproducibility | schema, gate, metrics |
| **thousands** | outcomes ingested automatically from CRM stage changes | Postgres, partitioned by tenant and labelled period | add per-segment metrics (by size band, by source) and confidence intervals; run nightly rather than on demand | schema, gate, metrics |

Three things are deliberately stable across all four rows, because they are what
would be expensive to change later:

1. **The case shape.** `signals` are supplied, so a case is replayable forever
   at zero model cost and a rubric change is the only variable.
2. **The metric set.** Accuracy, HOT precision, HOT recall, HOT conversion.
   Adding per-segment breakdowns is additive.
3. **The gate.** No regression, at least one improvement. It does not get
   weaker as `n` grows; it gets more meaningful.

What will need adding at ~100+ and is not built: statistical significance. At
twelve, a difference of one case is 8 percentage points and means nothing. The
gate should eventually require a difference larger than a confidence interval,
not merely larger than zero. That is the honest next step, and it is a change to
the *comparison*, not to the schema.

## Adding cases today

Edit `evals/golden/leads.json`, then mirror the change into workflow 15's
`Load Golden Set` node. `scripts/validate-evals.py` fails if the two disagree,
so the file stays authoritative and the drift is caught in CI rather than in a
number nobody can reproduce.

## What this does not measure

Only the rubric. Prompt changes, model changes and the outreach copy rules each
need their own comparison — and the outreach rules are already covered by the
fixtures in [`13`](../workflows/13-outreach-composer/), which is a different kind
of test: those assert behaviour, these measure quality.
