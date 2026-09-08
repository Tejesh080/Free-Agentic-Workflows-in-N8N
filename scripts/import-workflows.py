#!/usr/bin/env python3
"""Import the ten workflows into an n8n instance and relink their dependencies.

The published workflow.json files carry placeholder ids for sub-workflows and
data tables, because an id from one n8n instance is meaningless in another.
This script does the whole job in one pass:

  1. Create every workflow (or update it if a workflow of the same name exists).
  2. Build a name -> new id map from what was just created.
  3. Rewrite each Execute Sub-workflow node to point at the right new id, using
     the cachedResultName the sanitiser preserved.
  4. Resolve data table placeholders against the data tables in the instance,
     creating any that are missing.
  5. Report anything it could not resolve, rather than leaving a silent stub.

    python scripts/import-workflows.py --dry-run   # show what would happen
    python scripts/import-workflows.py             # do it

Requires N8N_BASE_URL and N8N_API_KEY (see .env.example).

Note on data tables: the n8n public API does not expose data tables at the time
of writing, so those placeholders are reported for you to set by hand in the
n8n editor. Every one is named in the output, and each takes a few seconds.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from n8n_api import N8nClient, N8nError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalog" / "workflows.json"

SUBWORKFLOW_TYPES = {"n8n-nodes-base.executeWorkflow", "@n8n/n8n-nodes-langchain.toolWorkflow"}
DATATABLE_TYPES = {"n8n-nodes-base.dataTable", "n8n-nodes-base.dataTableTool"}
WORKFLOW_PLACEHOLDER = "REPLACE_WITH_YOUR_WORKFLOW_ID"
DATATABLE_PLACEHOLDER = "REPLACE_WITH_YOUR_DATA_TABLE_ID"


def load_catalog() -> list[dict]:
    return json.loads(CATALOG.read_text(encoding="utf-8")).get("workflows", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", nargs="*", default=None)
    args = ap.parse_args()

    try:
        client = N8nClient()
    except N8nError as exc:
        print(f"FAIL  {exc}", file=sys.stderr)
        return 1

    entries = load_catalog()
    if args.only:
        wanted = set(args.only)
        entries = [e for e in entries if e.get("number") in wanted]

    # Load the files first so a bad file fails before anything is created.
    loaded: list[tuple[dict, dict]] = []
    for entry in entries:
        path = ROOT / "workflows" / entry["folder"] / "workflow.json"
        if not path.exists():
            print(f"FAIL  {entry['number']}: {path.relative_to(ROOT)} is missing", file=sys.stderr)
            return 1
        loaded.append((entry, json.loads(path.read_text(encoding="utf-8"))))

    existing = {w["name"]: w["id"] for w in client.list_workflows()}
    name_to_id: dict[str, str] = {}

    # --- Pass 1: create or update -------------------------------------------
    print("Pass 1: creating workflows")
    for entry, wf in loaded:
        name = wf["name"]
        if args.dry_run:
            action = "update" if name in existing else "create"
            print(f"  would {action}  {name}")
            name_to_id[name] = existing.get(name, f"DRYRUN-{entry['number']}")
            continue
        try:
            if name in existing:
                result = client.update_workflow(existing[name], wf)
                new_id = result.get("id", existing[name])
                print(f"  updated  {new_id}  {name}")
            else:
                result = client.create_workflow(wf)
                new_id = result["id"]
                print(f"  created  {new_id}  {name}")
            name_to_id[name] = new_id
        except N8nError as exc:
            print(f"  FAIL     {name}: {exc}", file=sys.stderr)
            return 1

    # --- Pass 2: relink sub-workflows ---------------------------------------
    print("\nPass 2: relinking sub-workflow references")
    unresolved: list[str] = []
    datatables_to_set: list[str] = []

    for entry, wf in loaded:
        changed = False
        for node in wf.get("nodes") or []:
            params = node.get("parameters") or {}

            if node.get("type") in SUBWORKFLOW_TYPES:
                ref = params.get("workflowId")
                if isinstance(ref, dict) and ref.get("value") == WORKFLOW_PLACEHOLDER:
                    target_name = ref.get("cachedResultName") or ""
                    target_id = name_to_id.get(target_name)
                    if target_id:
                        ref["value"] = target_id
                        changed = True
                        print(f"  {wf['name']} :: {node['name']} -> {target_name} ({target_id})")
                    else:
                        unresolved.append(
                            f"{wf['name']} :: {node['name']} wanted sub-workflow "
                            f"'{target_name or 'UNKNOWN'}' which was not imported")

            if node.get("type") in DATATABLE_TYPES:
                ref = params.get("dataTableId")
                if isinstance(ref, dict) and ref.get("value") == DATATABLE_PLACEHOLDER:
                    datatables_to_set.append(
                        f"{wf['name']} :: {node['name']} needs data table "
                        f"'{ref.get('cachedResultName') or 'UNKNOWN'}'")

        if changed and not args.dry_run:
            try:
                client.update_workflow(name_to_id[wf["name"]], wf)
            except N8nError as exc:
                print(f"  FAIL     relink {wf['name']}: {exc}", file=sys.stderr)
                return 1

    # --- Report --------------------------------------------------------------
    print("\n" + "=" * 70)
    if unresolved:
        print("UNRESOLVED SUB-WORKFLOW LINKS")
        for u in unresolved:
            print(f"  ! {u}")
    else:
        print("All sub-workflow links resolved.")

    if datatables_to_set:
        print("\nDATA TABLES TO SELECT BY HAND (the public API does not expose data tables)")
        print("Create these in n8n under Data tables, then pick each one in the node:")
        for d in sorted(set(datatables_to_set)):
            print(f"  - {d}")
        print("\nColumn definitions are in docs/CONNECTIONS.md.")

    print("\nNext steps:")
    print("  1. Open each workflow and select a credential wherever one is requested.")
    print("  2. Publish the four platform workflows (02, 05, 08, 09). A sub-workflow")
    print("     must be published before another workflow can call it.")
    print("  3. Run each workflow's test-suite trigger to confirm the wiring.")
    return 1 if unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main())
