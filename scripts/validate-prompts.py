#!/usr/bin/env python3
"""Validate the prompt registry served by 08 GitOps Prompt Management.

Checks, per file under prompts/**.md (excluding README.md):
  1. YAML-ish front matter is present and parses.
  2. Required keys: id, version, description, variables, owner, updated.
  3. `id` equals the file's path relative to prompts/, minus the .md suffix.
  4. `version` is a positive integer.
  5. Every {{placeholder}} in the body is declared in `variables`.
  6. Every declared variable appears at least once in the body.
  7. The body is non-empty.
  8. `updated` is an ISO date.

Deliberately does not require PyYAML: the front matter here is a flat subset
(scalars plus one bracketed list), so CI needs no dependencies.

Usage: python scripts/validate-prompts.py [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = ROOT / "prompts"
REQUIRED = ["id", "version", "description", "variables", "owner", "updated"]
PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_front_matter(text: str):
    """Return (meta_dict, body) or (None, reason)."""
    if not text.startswith("---"):
        return None, "file does not start with a --- front matter block"
    parts = text.split("\n---", 1)
    if len(parts) != 2:
        return None, "front matter block is not closed with ---"
    head = parts[0][3:].strip("\n")
    body = parts[1].lstrip("\n")
    meta = {}
    for line in head.splitlines():
        line = line.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            return None, f"front matter line is not key: value -> {line!r}"
        key, _, raw = line.partition(":")
        key = key.strip()
        raw = raw.strip()
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            meta[key] = [v.strip().strip("'\"") for v in inner.split(",") if v.strip()] if inner else []
        elif re.fullmatch(r"-?\d+", raw):
            meta[key] = int(raw)
        else:
            meta[key] = raw.strip("'\"")
    return meta, body


def validate(path: Path) -> list[str]:
    rel = path.relative_to(PROMPTS).as_posix()
    expected_id = rel[:-3] if rel.endswith(".md") else rel
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")

    meta, body = parse_front_matter(text)
    if meta is None:
        return [f"{rel}: {body}"]

    for key in REQUIRED:
        if key not in meta:
            errors.append(f"{rel}: missing required front matter key '{key}'")
    if errors:
        return errors

    if meta["id"] != expected_id:
        errors.append(f"{rel}: id is '{meta['id']}' but the file path implies '{expected_id}'")

    if not isinstance(meta["version"], int) or meta["version"] < 1:
        errors.append(f"{rel}: version must be a positive integer, got {meta['version']!r}")

    if not isinstance(meta["variables"], list):
        errors.append(f"{rel}: variables must be a bracketed list, e.g. [a, b]")
        return errors

    if not str(meta["description"]).strip():
        errors.append(f"{rel}: description is empty")

    if not DATE_RE.match(str(meta["updated"])):
        errors.append(f"{rel}: updated must be an ISO date (YYYY-MM-DD), got {meta['updated']!r}")

    if not body.strip():
        errors.append(f"{rel}: prompt body is empty")

    declared = set(meta["variables"])
    used = set(PLACEHOLDER_RE.findall(body))

    for name in sorted(used - declared):
        errors.append(f"{rel}: body uses {{{{{name}}}}} but it is not declared in variables")
    for name in sorted(declared - used):
        errors.append(f"{rel}: variables declares '{name}' but the body never uses it")

    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    if not PROMPTS.is_dir():
        print("prompts/ directory not found", file=sys.stderr)
        return 2

    files = sorted(p for p in PROMPTS.rglob("*.md") if p.name != "README.md")
    all_errors: list[str] = []
    ids: dict[str, str] = {}

    for path in files:
        errs = validate(path)
        all_errors.extend(errs)
        meta, _ = parse_front_matter(path.read_text(encoding="utf-8"))
        if isinstance(meta, dict) and "id" in meta:
            pid = str(meta["id"])
            rel = path.relative_to(ROOT).as_posix()
            if pid in ids:
                all_errors.append(f"{rel}: duplicate prompt id '{pid}', already used by {ids[pid]}")
            else:
                ids[pid] = rel

    if args.as_json:
        print(json.dumps({"files": len(files), "prompt_ids": sorted(ids), "errors": all_errors}, indent=2))
    else:
        print(f"validate-prompts: checked {len(files)} prompt file(s)")
        if all_errors:
            for e in all_errors:
                print(f"  FAIL  {e}")
            print(f"\n{len(all_errors)} error(s)")
        else:
            print("PASS  all prompts valid")
            for pid in sorted(ids):
                print(f"  - {pid}")

    return 1 if all_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
