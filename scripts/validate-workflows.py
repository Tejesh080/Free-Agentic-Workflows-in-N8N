#!/usr/bin/env python3
"""Offline structural validation of every published workflow.json.

Runs in CI with no credentials and no n8n instance. It answers one question:
would this file import into a clean n8n and be wired the way the docs claim?

Checks per workflow file
  1. Valid JSON with the keys n8n's importer needs (name, nodes, connections).
  2. Node names are unique - n8n addresses nodes by name, so a duplicate is a
     silently broken workflow.
  3. Every connection references a node that exists, in both directions.
  4. Every node declares a type and a typeVersion.
  5. At least one trigger node, otherwise the workflow can never start.
  6. No orphan nodes (excluding sticky notes, triggers and AI sub-nodes, which
     legitimately have no main-flow input).
  7. Expressions referencing $('Node Name') point at a node that exists. This
     catches the most common breakage after a rename.
  8. Sub-workflow and data table ids are placeholders, not live instance ids.

Cross-file checks
  9. Every folder listed in catalog/workflows.json has a workflow.json.
 10. Every workflow.json is listed in the catalog.

Usage: python scripts/validate-workflows.py [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF_DIR = ROOT / "workflows"
CATALOG = ROOT / "catalog" / "workflows.json"

TRIGGER_HINTS = ("trigger", "webhook")
SUBNODE_CONNECTION_TYPES = {
    "ai_languageModel", "ai_embedding", "ai_document", "ai_textSplitter",
    "ai_memory", "ai_tool", "ai_outputParser", "ai_vectorStore", "ai_retriever",
    "ai_reranker",
}
NODE_REF_RE = re.compile(r"\$\(\s*['\"]([^'\"]+)['\"]\s*\)")
PLACEHOLDER_VALUES = {"REPLACE_WITH_YOUR_WORKFLOW_ID", "REPLACE_WITH_YOUR_DATA_TABLE_ID"}


def is_trigger(node: dict) -> bool:
    t = str(node.get("type", "")).lower()
    return any(h in t for h in TRIGGER_HINTS)


def walk_strings(value, out: list[str]) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            walk_strings(v, out)
    elif isinstance(value, list):
        for v in value:
            walk_strings(v, out)


def validate_file(path: Path) -> list[str]:
    rel = path.relative_to(ROOT).as_posix()
    errors: list[str] = []
    try:
        wf = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"{rel}: invalid JSON - {exc}"]

    for key in ("name", "nodes", "connections"):
        if key not in wf:
            errors.append(f"{rel}: missing top-level key '{key}'")
    if errors:
        return errors

    nodes = wf.get("nodes") or []
    if not nodes:
        return [f"{rel}: has no nodes"]

    names: list[str] = []
    for node in nodes:
        name = node.get("name")
        if not name:
            errors.append(f"{rel}: a node has no name")
            continue
        names.append(name)
        if not node.get("type"):
            errors.append(f"{rel}: node '{name}' has no type")
        if node.get("typeVersion") is None:
            errors.append(f"{rel}: node '{name}' has no typeVersion")

    seen = set()
    for n in names:
        if n in seen:
            errors.append(f"{rel}: duplicate node name '{n}' - n8n addresses nodes by name")
        seen.add(n)
    name_set = set(names)

    # Connections
    targeted: set[str] = set()
    for source, spec in (wf.get("connections") or {}).items():
        if source not in name_set:
            errors.append(f"{rel}: connection source '{source}' is not a node in this workflow")
        if not isinstance(spec, dict):
            errors.append(f"{rel}: connections for '{source}' are malformed")
            continue
        for conn_type, outputs in spec.items():
            for output in outputs or []:
                for conn in output or []:
                    target = conn.get("node")
                    if target not in name_set:
                        errors.append(
                            f"{rel}: connection {source} -> '{target}' targets a node that does not exist")
                    else:
                        targeted.add(target)
                        if conn_type in SUBNODE_CONNECTION_TYPES:
                            targeted.add(source)

    # Triggers
    if not any(is_trigger(n) for n in nodes):
        errors.append(f"{rel}: no trigger node, so this workflow can never start")

    # Orphans
    connected_sources = set(wf.get("connections") or {})
    for node in nodes:
        name = node.get("name")
        ntype = str(node.get("type", ""))
        if not name or ntype.endswith("stickyNote"):
            continue
        if is_trigger(node):
            continue
        if name in targeted or name in connected_sources:
            continue
        errors.append(f"{rel}: node '{name}' is not connected to anything")

    # Expression node references
    strings: list[str] = []
    walk_strings(wf.get("nodes"), strings)
    referenced = set()
    for s in strings:
        for m in NODE_REF_RE.finditer(s):
            referenced.add(m.group(1))
    for ref in sorted(referenced):
        if ref not in name_set:
            errors.append(f"{rel}: an expression references $('{ref}') but no node has that name")

    # Instance-specific ids must have been replaced by the sanitiser
    for node in nodes:
        params = node.get("parameters") or {}
        for key in ("workflowId", "dataTableId"):
            val = params.get(key)
            if isinstance(val, dict) and val.get("value"):
                if val["value"] not in PLACEHOLDER_VALUES:
                    errors.append(
                        f"{rel}: node '{node.get('name')}' still carries a live {key} "
                        f"('{val['value']}'). Run scripts/sanitize-workflow.py.")

    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    files = sorted(WF_DIR.glob("*/workflow.json"))
    all_errors: list[str] = []
    for f in files:
        all_errors.extend(validate_file(f))

    # Cross-check against the catalog
    if CATALOG.exists():
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        listed = {w["folder"] for w in catalog.get("workflows", [])}
        present = {f.parent.name for f in files}
        for folder in sorted(listed - present):
            all_errors.append(f"catalog lists '{folder}' but workflows/{folder}/workflow.json is missing")
        for folder in sorted(present - listed):
            all_errors.append(f"workflows/{folder}/workflow.json exists but is not listed in the catalog")
    else:
        all_errors.append("catalog/workflows.json is missing")

    if args.as_json:
        print(json.dumps({"files": len(files), "errors": all_errors}, indent=2))
    else:
        print(f"validate-workflows: checked {len(files)} workflow file(s)")
        if all_errors:
            for e in all_errors:
                print(f"  FAIL  {e}")
            print(f"\n{len(all_errors)} error(s)")
        else:
            print("PASS  all workflows are structurally valid and match the catalog")
    return 1 if all_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
