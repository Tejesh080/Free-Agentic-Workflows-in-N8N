#!/usr/bin/env python3
"""Check the golden set in the repository against the copy embedded in workflow 15.

The evaluation harness has to carry its own data: an n8n Code node cannot read a
file from this repository at run time. That leaves two copies of the labels, and
two copies drift. This script fails the build when they disagree, so the file
stays the source of truth and the workflow stays the thing that runs.

    python scripts/validate-evals.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "evals" / "golden" / "leads.json"
CANDIDATE = ROOT / "evals" / "rubrics" / "candidate-2.0.0.json"
WORKFLOW = ROOT / "workflows" / "15-evaluation-harness" / "workflow.json"

TIERS = {"HOT", "WARM", "COLD", "DISQUALIFIED"}
OUTCOMES = {"won", "lost", "no_reply"}
SIGNAL_KEYS = {
    "seniority", "decision_authority", "company_size_band", "budget_signal",
    "timeline", "pain_specificity", "use_case_fit", "competitor_mentioned", "evidence",
}


def load_embedded_js() -> str:
    wf = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    for node in wf["nodes"]:
        if node.get("name") == "Load Golden Set":
            return node["parameters"]["jsCode"]
    raise SystemExit("workflow 15 has no 'Load Golden Set' node")


def main() -> int:
    problems: list[str] = []

    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    cases = golden["cases"]
    js = load_embedded_js()

    # 1. The labels themselves must be well formed. A typo in a tier silently
    #    makes every rubric look wrong against that row.
    seen: set[str] = set()
    for c in cases:
        cid = c["case_id"]
        if cid in seen:
            problems.append(f"{cid}: duplicate case_id")
        seen.add(cid)
        if c["expected_tier"] not in TIERS:
            problems.append(f"{cid}: expected_tier {c['expected_tier']!r} is not one of {sorted(TIERS)}")
        if c["outcome"] not in OUTCOMES:
            problems.append(f"{cid}: outcome {c['outcome']!r} is not one of {sorted(OUTCOMES)}")
        if not c.get("lead", {}).get("email"):
            problems.append(f"{cid}: lead.email is required")
        unknown = set(c.get("signals", {})) - SIGNAL_KEYS
        if unknown:
            problems.append(f"{cid}: unknown signal key(s) {sorted(unknown)}")

    # 2. Every labelled case must appear in the workflow with the same label and
    #    the same outcome, in the exact shape the renderer emits.
    for c in cases:
        needle = (
            f'case_id: "{c["case_id"]}", '
            f'expected_tier: "{c["expected_tier"]}", '
            f'outcome: "{c["outcome"]}"'
        )
        if needle not in js:
            problems.append(
                f"{c['case_id']}: not found in workflow 15 with tier={c['expected_tier']} "
                f"outcome={c['outcome']} (the embedded copy has drifted)"
            )

    # 3. No extra cases in the workflow that the repository does not know about.
    embedded_ids = set(re.findall(r'case_id:\s*"([^"]+)"', js))
    extra = embedded_ids - seen
    if extra:
        problems.append(f"workflow 15 scores case(s) {sorted(extra)} that are not in {GOLDEN.name}")

    # 4. The candidate rubric's thresholds must match the file it is named after,
    #    otherwise a recorded result describes a rubric nobody can reproduce.
    candidate = json.loads(CANDIDATE.read_text(encoding="utf-8"))
    tiers = candidate["tiers"]
    tier_needle = (
        f'tiers: {{ hot: {tiers["hot"]}, warm: {tiers["warm"]}, cold: {tiers["cold"]} }}'
    )
    if tier_needle not in js:
        problems.append(
            f"candidate rubric thresholds in {CANDIDATE.name} ({tiers}) do not match workflow 15"
        )
    if f'version: "{candidate["version"]}"' not in js:
        problems.append(f"candidate rubric version {candidate['version']!r} does not match workflow 15")

    print(f"validate-evals: {len(cases)} labelled lead(s) in {GOLDEN.relative_to(ROOT)}")
    label_counts: dict[str, int] = {}
    for c in cases:
        label_counts[c["expected_tier"]] = label_counts.get(c["expected_tier"], 0) + 1
    print("  labels: " + ", ".join(f"{k}={v}" for k, v in sorted(label_counts.items())))

    if problems:
        print(f"\nFAIL  {len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1

    print("PASS  the golden set and workflow 15 agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
