#!/usr/bin/env python3
"""Export this repository's workflows from a live n8n instance into this repository.

Fetches each workflow by id, runs it through the sanitiser, and writes it to
`workflows/<folder>/workflow.json`. The raw export is optionally kept under
`.n8n-live/` (git-ignored) so you can diff what changed before committing.

    python scripts/export-workflows.py               # export all, sanitised
    python scripts/export-workflows.py --keep-raw    # also keep the raw export
    python scripts/export-workflows.py --only 02 09  # export a subset

The mapping of workflow id to repository folder lives in catalog/workflows.json,
which is the single place to update if an id changes.
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
RAW_DIR = ROOT / ".n8n-live"


def load_catalog() -> list[dict]:
    if not CATALOG.exists():
        raise SystemExit(f"catalog not found: {CATALOG}. Run scripts/generate-catalog.py first.")
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    return data.get("workflows", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None,
                    help="export only these numbers, e.g. --only 02 09")
    ap.add_argument("--keep-raw", action="store_true",
                    help="also write the unsanitised export under .n8n-live/ (git-ignored)")
    args = ap.parse_args()

    sys.path.insert(0, str(ROOT / "scripts"))
    from importlib import import_module
    sanitize_mod = import_module("sanitize-workflow".replace("-", "_")) if False else None

    # sanitize-workflow.py has a dash in its name, so load it by path.
    import importlib.util
    spec = importlib.util.spec_from_file_location("sanitize_workflow", ROOT / "scripts" / "sanitize-workflow.py")
    sanitize_workflow = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(sanitize_workflow)

    try:
        client = N8nClient()
    except N8nError as exc:
        print(f"FAIL  {exc}", file=sys.stderr)
        return 1

    entries = load_catalog()
    if args.only:
        wanted = set(args.only)
        entries = [e for e in entries if e.get("number") in wanted]
        if not entries:
            print(f"no catalog entries matched {sorted(wanted)}", file=sys.stderr)
            return 1

    exported = 0
    failures = 0
    for entry in entries:
        wid = entry.get("n8n_workflow_id")
        folder = entry.get("folder")
        if not wid or wid.startswith("REPLACE"):
            print(f"SKIP  {entry.get('number')} {entry.get('name')}: no workflow id in the catalog")
            continue
        try:
            raw = client.get_workflow(wid)
        except N8nError as exc:
            print(f"FAIL  {entry.get('number')}: {exc}", file=sys.stderr)
            failures += 1
            continue

        if args.keep_raw:
            RAW_DIR.mkdir(exist_ok=True)
            (RAW_DIR / f"{folder}.raw.json").write_text(
                json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        clean, notes = sanitize_workflow.sanitize(raw)
        dest = ROOT / "workflows" / folder / "workflow.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(clean, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        node_count = len(clean.get("nodes") or [])
        print(f"OK    {entry.get('number')} -> {dest.relative_to(ROOT)}  ({node_count} nodes, {len(notes)} sanitiser change(s))")
        exported += 1

    print(f"\nexported {exported} workflow(s), {failures} failure(s)")
    print("Now run: python scripts/security-check.py")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
