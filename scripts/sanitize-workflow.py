#!/usr/bin/env python3
"""Turn a raw n8n workflow export into a safe, importable public artifact.

A raw export from a live n8n instance is not safe to publish. It carries
credential identifiers, an instance identifier, pinned runtime payloads, and
internal workflow ids that mean nothing outside the instance it came from.

This script strips all of that while keeping the file importable: credentials
are kept **by name only**, which is exactly what n8n's importer needs in order
to show "select a credential" rather than silently binding to nothing.

  python scripts/sanitize-workflow.py raw.json > workflow.json
  python scripts/sanitize-workflow.py --in-place workflows/**/workflow.json

What is removed
  * `meta.instanceId`            identifies the source n8n instance
  * `pinData`                    may embed real payloads captured during testing
  * `credentials[*].id`          instance-specific credential identifiers
  * `versionId`, `shared`, `homeProject`, `triggerCount`, `staticData`
  * top-level `id`, `createdAt`, `updatedAt`, `active`
  * `webhookId` on webhook nodes (regenerated on import; publishing it leaks
    the live callback URL of the source instance)

What is rewritten
  * `parameters.workflowId` on Execute Sub-workflow nodes is replaced with a
    documented placeholder, because a sub-workflow id is meaningless in another
    instance. `docs/CONNECTIONS.md` explains the re-linking step.
  * `parameters.dataTableId` likewise.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DROP_TOP = ["id", "meta", "pinData", "versionId", "active", "createdAt", "updatedAt",
            "shared", "homeProject", "triggerCount", "staticData", "isArchived",
            "scopes", "activeVersionId", "parentFolderId",
            # activeVersion is server-side publish state. It carries a second,
            # UNSANITISED copy of every node - live workflow ids, data table ids,
            # webhook ids and credential ids - plus the author's name, n8n user id
            # and publish history. The importer never reads it (it POSTs only name,
            # nodes, connections and settings), so it is dropped outright.
            "activeVersion", "versionCounter", "sourceWorkflowId"]

SUBWORKFLOW_TYPES = {"n8n-nodes-base.executeWorkflow", "@n8n/n8n-nodes-langchain.toolWorkflow"}
DATATABLE_TYPES = {"n8n-nodes-base.dataTable", "n8n-nodes-base.dataTableTool"}


def sanitize(wf: dict, keep_links: bool = False) -> tuple[dict, list[str]]:
    notes: list[str] = []
    out = {k: v for k, v in wf.items() if k not in DROP_TOP}

    for key in DROP_TOP:
        if key in wf and wf[key] not in (None, {}, [], False):
            notes.append(f"removed top-level '{key}'")

    nodes = out.get("nodes") or []
    for node in nodes:
        name = node.get("name", "?")

        creds = node.get("credentials")
        if isinstance(creds, dict):
            for ctype, ref in list(creds.items()):
                if isinstance(ref, dict) and "id" in ref:
                    ref.pop("id", None)
                    notes.append(f"stripped credential id from '{name}' ({ctype})")
                if isinstance(ref, dict) and not ref.get("name"):
                    ref["name"] = f"Set your {ctype} credential"

        if node.get("webhookId"):
            node.pop("webhookId", None)
            notes.append(f"removed webhookId from '{name}'")

        params = node.get("parameters") or {}

        if node.get("type") in SUBWORKFLOW_TYPES and not keep_links:
            wid = params.get("workflowId")
            if isinstance(wid, dict) and wid.get("value"):
                params["workflowId"] = {
                    "__rl": True, "mode": "id",
                    "value": "REPLACE_WITH_YOUR_WORKFLOW_ID",
                    "cachedResultName": wid.get("cachedResultName", ""),
                }
                notes.append(f"replaced sub-workflow id on '{name}' with a placeholder")

        if node.get("type") in DATATABLE_TYPES and not keep_links:
            did = params.get("dataTableId")
            if isinstance(did, dict) and did.get("value"):
                params["dataTableId"] = {
                    "__rl": True, "mode": "id",
                    "value": "REPLACE_WITH_YOUR_DATA_TABLE_ID",
                    "cachedResultName": did.get("cachedResultName", ""),
                }
                notes.append(f"replaced data table id on '{name}' with a placeholder")

    settings = out.get("settings")
    if isinstance(settings, dict):
        settings.pop("availableInMCP", None)
        if settings.get("errorWorkflow"):
            settings.pop("errorWorkflow")
            notes.append("removed instance-specific errorWorkflow setting")

    ordered = {}
    for key in ("name", "nodes", "connections", "settings", "tags"):
        if key in out:
            ordered[key] = out[key]
    for key, value in out.items():
        if key not in ordered:
            ordered[key] = value
    return ordered, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--keep-links", action="store_true",
                    help="keep sub-workflow and data table ids (for a private local copy only)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    for f in args.files:
        path = Path(f)
        wf = json.loads(path.read_text(encoding="utf-8"))
        clean, notes = sanitize(wf, keep_links=args.keep_links)
        text = json.dumps(clean, indent=2, ensure_ascii=False) + "\n"
        if args.in_place:
            path.write_text(text, encoding="utf-8")
            if not args.quiet:
                print(f"{path}: {len(notes)} change(s)")
                for n in notes:
                    print(f"    - {n}")
        else:
            sys.stdout.write(text)
            if not args.quiet:
                for n in notes:
                    print(f"# {n}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
