#!/usr/bin/env python3
"""Secret and credential-leak scanner for this repository.

Exits non-zero when anything that must never be published is found.

What it looks for
  1. Provider API keys and tokens (OpenAI, Anthropic, Google, GitHub, Slack,
     AWS, Apify, Firecrawl, HuggingFace, generic JWTs).
  2. Database and service URLs carrying inline credentials.
  3. n8n credential identifiers inside published workflow JSON. A public export
     must reference credentials by *name only* - an `id` ties the file to one
     specific n8n instance and leaks internal identifiers.
  4. n8n instance identifiers (`meta.instanceId`) and captured runtime payloads
     (`pinData`) inside published workflow JSON.
  5. Personal contact details (email addresses, phone numbers) outside an
     explicit allow-list of example domains.
  6. Private / RFC1918 URLs and tunnel hostnames.

Usage
    python scripts/security-check.py            # scan tracked files
    python scripts/security-check.py --all      # scan the whole working tree
    python scripts/security-check.py --json     # machine-readable output
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Directories never scanned for secrets (binary or vendored).
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", ".build"}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".ico", ".woff", ".woff2"}

# This file necessarily contains the patterns it searches for.
SELF = "scripts/security-check.py"

# Domains that are safe to appear in documentation and fixtures.
# Reserved by RFC 2606 and RFC 6761: guaranteed never to be delegated, so an
# address here is a fixture by construction rather than by convention.
RESERVED_TLDS = (".example", ".test", ".invalid", ".localhost")

ALLOWED_EMAIL_DOMAINS = {
    "example.com", "example.org", "example.net", "invalid",
    "acme-supplies.example", "northwind.example", "vendor.example",
    "users.noreply.github.com", "noreply.github.com",
}

# Two fixtures need an address at a *real* free-email provider, because the
# thing under test is the consumer-domain penalty and a reserved domain would
# not trigger it. Both are synthetic and named here rather than allowing the
# whole domain, which is the one most likely to carry a genuine leak.
ALLOWED_EMAIL_ADDRESSES = {
    "ada.lovelace@gmail.com",   # 12 Q08: asserts the -8 consumer-domain modifier
    "strong.buyer@gmail.com",   # golden G12: a strong buyer on a personal address
}

SECRET_PATTERNS: list[tuple[str, str, str]] = [
    # (id, severity, regex)
    ("openai_key", "critical", r"\bsk-[A-Za-z0-9_\-]{20,}"),
    ("anthropic_key", "critical", r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    ("google_api_key", "critical", r"\bAIza[0-9A-Za-z_\-]{30,}"),
    ("github_token", "critical", r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    ("slack_token", "critical", r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    ("aws_access_key", "critical", r"\bAKIA[0-9A-Z]{16}\b"),
    ("apify_token", "critical", r"\bapify_api_[A-Za-z0-9]{20,}"),
    ("firecrawl_key", "critical", r"\bfc-[A-Za-z0-9]{24,}"),
    ("huggingface_token", "critical", r"\bhf_[A-Za-z0-9]{30,}"),
    ("pinata_token", "critical", r"\bpina_[A-Z0-9]{40,}"),
    ("jwt", "high", r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    ("bearer_literal", "high", r"[Bb]earer\s+[A-Za-z0-9_\-\.]{24,}"),
    ("db_url_with_password", "critical",
     r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s\"'<>{}]*:[^\s\"'<>{}/@]+@"),
    ("supabase_project_url", "high", r"https://[a-z0-9]{18,}\.supabase\.co"),
    ("tunnel_host", "medium", r"https?://[a-z0-9\-]+\.(?:ngrok[a-z\-\.]*|loca\.lt|trycloudflare\.com)[^\s\"']*"),
    ("private_network_url", "medium",
     r"https?://(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.[0-9.]+(?::\d+)?"),
    ("phone_number", "medium", r"\+\d{1,3}[\s\-]\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}\b"),
]

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b")

# Placeholder shapes that are intentionally present in .env.example and docs.
PLACEHOLDER_RE = re.compile(
    r"(?:\$\{[A-Z0-9_]+\}|<[A-Za-z0-9 _\-]+>|YOUR[_-]|CHANGE[_-]?ME|xxx+|\.\.\.|"
    r"REPLACE|PLACEHOLDER|example|EXAMPLE|sk-\.\.\.)",
)


def tracked_files() -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return walk_files()
    return [ROOT / line for line in out.splitlines() if line.strip()]


def walk_files() -> list[Path]:
    """Whole working tree, minus anything git ignores.

    --all exists to catch files that are not staged yet. It must still skip
    git-ignored paths: .env legitimately holds real secrets and is never
    published, so flagging it would train the reader to ignore the scanner.
    """
    ignored: set[Path] = set()
    try:
        out = subprocess.run(
            ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
        ignored = {ROOT / line.rstrip("/") for line in out.splitlines() if line.strip()}
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    def is_ignored(path: Path) -> bool:
        return any(path == i or i in path.parents for i in ignored)

    files = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
            continue
        if is_ignored(p):
            continue
        files.append(p)
    return files


def scan_text(rel: str, text: str) -> list[dict]:
    findings = []
    lines = text.splitlines()
    for idx, line in enumerate(lines, start=1):
        for pid, severity, pattern in SECRET_PATTERNS:
            for m in re.finditer(pattern, line):
                snippet = m.group(0)
                if PLACEHOLDER_RE.search(snippet):
                    continue
                findings.append({
                    "file": rel, "line": idx, "rule": pid,
                    "severity": severity, "match": redact(snippet),
                })
        for m in EMAIL_RE.finditer(line):
            domain = m.group(1).lower()
            # RFC 2606 reserves .test, .example, .invalid and .localhost for
            # testing and documentation. None of them can resolve to a real
            # host, so an address in one cannot belong to a real person. The
            # list previously allowed .example only, which flagged every
            # fixture in the control plane's test suite while letting an
            # identical .example address through.
            if domain in ALLOWED_EMAIL_DOMAINS or domain.endswith(RESERVED_TLDS):
                continue
            if m.group(0).lower() in ALLOWED_EMAIL_ADDRESSES:
                continue
            findings.append({
                "file": rel, "line": idx, "rule": "personal_email",
                "severity": "high", "match": redact(m.group(0)),
            })
    return findings


def redact(s: str) -> str:
    if len(s) <= 12:
        return s[:4] + "***"
    return s[:6] + "***" + s[-4:]


def scan_workflow_json(rel: str, text: str) -> list[dict]:
    """Structural checks that only apply to published n8n workflow exports."""
    findings = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return [{"file": rel, "line": 0, "rule": "invalid_json",
                 "severity": "critical", "match": str(exc)[:120]}]
    if not isinstance(data, dict) or "nodes" not in data:
        return findings

    if "pinData" in data and data["pinData"]:
        findings.append({"file": rel, "line": 0, "rule": "pinned_runtime_data",
                         "severity": "high",
                         "match": "pinData present - may embed real payloads"})

    meta = data.get("meta") or {}
    if isinstance(meta, dict) and meta.get("instanceId"):
        findings.append({"file": rel, "line": 0, "rule": "n8n_instance_id",
                         "severity": "high",
                         "match": "meta.instanceId identifies a specific n8n instance"})

    if data.get("activeVersion"):
        findings.append({"file": rel, "line": 0, "rule": "server_version_block",
                         "severity": "critical",
                         "match": "activeVersion present - holds a second, unsanitised copy of every node"})

    # Walk the WHOLE document, not just data["nodes"]. A credential id nested in a
    # server-side block is exactly as published as one in the node list.
    def walk(value, path: str) -> None:
        if isinstance(value, dict):
            for ctype, cref in (value.get("credentials") or {}).items():
                if isinstance(cref, dict) and cref.get("id"):
                    findings.append({
                        "file": rel, "line": 0, "rule": "credential_id_reference",
                        "severity": "critical",
                        "match": f"{path or 'root'} node '{value.get('name')}' "
                                 f"credential '{ctype}' carries an instance id",
                    })
            for k, v in value.items():
                walk(v, f"{path}.{k}" if path else k)
        elif isinstance(value, list):
            for v in value:
                walk(v, path)

    walk(data, "")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="scan the whole working tree, not just tracked files")
    ap.add_argument("--json", action="store_true", dest="as_json", help="emit JSON")
    args = ap.parse_args()

    files = walk_files() if args.all else tracked_files()
    findings: list[dict] = []
    scanned = 0

    for path in files:
        if not path.exists() or not path.is_file():
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel == SELF:
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        findings.extend(scan_text(rel, text))
        if path.name.endswith(".json") and "workflows/" in rel:
            findings.extend(scan_workflow_json(rel, text))

    blocking = [f for f in findings if f["severity"] in ("critical", "high")]

    if args.as_json:
        print(json.dumps({"scanned_files": scanned, "findings": findings,
                          "blocking": len(blocking)}, indent=2))
    else:
        print(f"security-check: scanned {scanned} files")
        if not findings:
            print("PASS  no secrets, credential ids, instance ids or personal data found")
        else:
            for f in sorted(findings, key=lambda x: (x["severity"], x["file"])):
                print(f"  [{f['severity']:8}] {f['file']}:{f['line']}  {f['rule']}  {f['match']}")
            print(f"\n{len(blocking)} blocking finding(s), {len(findings) - len(blocking)} advisory")

    return 1 if blocking else 0


if __name__ == "__main__":
    raise SystemExit(main())
