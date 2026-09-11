#!/usr/bin/env python3
"""Pull a test-suite result out of a recorded n8n execution and write it to disk.

The assertion node in each workflow's suite already produces the verdict. This
script fetches that node's output from the execution that produced it, rather
than letting anyone retype a number into a results file by hand.

    python scripts/capture-test-evidence.py 11 415 "Assert CRM Results"
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from n8n_api import N8nClient  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CATALOG = json.loads((ROOT / "catalog" / "workflows.json").read_text(encoding="utf-8"))


def folder_for(number: str) -> Path:
    for w in CATALOG["workflows"]:
        if w["number"] == number:
            return ROOT / "workflows" / w["folder"]
    raise SystemExit(f"no catalog entry for workflow {number}")


def workflow_name(number: str) -> str:
    for w in CATALOG["workflows"]:
        if w["number"] == number:
            return w["name"]
    return number


def main() -> int:
    number, execution_id, node_name = sys.argv[1], sys.argv[2], sys.argv[3]
    note = sys.argv[4] if len(sys.argv) > 4 else ""

    client = N8nClient()
    data = client._request("GET", f"/executions/{execution_id}?includeData=true")

    run = data["data"]["resultData"]["runData"][node_name][0]
    verdict = run["data"]["main"][0][0]["json"]

    latencies = sorted(c.get("latency_ms") or 0 for c in verdict.get("cases", []))
    p50 = latencies[len(latencies) // 2] if latencies else None

    out = {
        "suite": verdict.get("suite"),
        "generated_at": data["execution"]["stoppedAt"] if "execution" in data else verdict.get("run_at"),
        "n8n_execution_id": str(execution_id),
        "workflow": workflow_name(number),
        "how_to_reproduce": "Open the workflow in n8n and run the 'Test Suite Trigger' manual trigger.",
        "note": note,
        "total": verdict.get("total"),
        "passed": verdict.get("passed"),
        "failed": verdict.get("failed"),
        "all_passed": verdict.get("all_passed"),
        "latency_ms_p50_measured": p50,
        "latency_ms_max_measured": latencies[-1] if latencies else None,
        "cases": verdict.get("cases", []),
    }
    for key in ("rubric_version",):
        if key in verdict:
            out[key] = verdict[key]

    dest = folder_for(number) / "tests" / "results-2026-09-12.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"OK    {number} -> {dest.relative_to(ROOT)}  ({out['passed']}/{out['total']} passed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
