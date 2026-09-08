#!/usr/bin/env python3
"""Thin n8n public REST API client shared by the import and export scripts.

Reads N8N_BASE_URL and N8N_API_KEY from the environment, or from a .env file in
the repository root if present. Uses only the standard library so CI needs no
dependencies.

Create an API key in n8n: Settings -> n8n API -> Create an API key.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv() -> None:
    """Populate os.environ from .env without overwriting real environment vars."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


class N8nError(RuntimeError):
    pass


class N8nClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None) -> None:
        load_dotenv()
        self.base_url = (base_url or os.environ.get("N8N_BASE_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("N8N_API_KEY", "")
        if not self.base_url:
            raise N8nError(
                "N8N_BASE_URL is not set. Copy .env.example to .env and fill it in, "
                "or export the variable."
            )
        if not self.api_key:
            raise N8nError(
                "N8N_API_KEY is not set. Create one in n8n under "
                "Settings -> n8n API -> Create an API key, then put it in .env."
            )

    def _request(self, method: str, path: str, payload: dict | None = None,
                 query: dict | None = None) -> dict:
        url = f"{self.base_url}/api/v1{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-N8N-API-KEY", self.api_key)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:600]
            raise N8nError(f"{method} {path} failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise N8nError(f"{method} {path} could not reach {self.base_url}: {exc.reason}") from exc

    def list_workflows(self, limit: int = 200) -> list[dict]:
        out: list[dict] = []
        cursor = None
        while True:
            query = {"limit": min(limit, 100)}
            if cursor:
                query["cursor"] = cursor
            page = self._request("GET", "/workflows", query=query)
            out.extend(page.get("data") or [])
            cursor = page.get("nextCursor")
            if not cursor:
                return out

    def get_workflow(self, workflow_id: str) -> dict:
        return self._request("GET", f"/workflows/{workflow_id}")

    def create_workflow(self, workflow: dict) -> dict:
        body = {k: workflow[k] for k in ("name", "nodes", "connections", "settings") if k in workflow}
        body.setdefault("settings", {})
        return self._request("POST", "/workflows", payload=body)

    def update_workflow(self, workflow_id: str, workflow: dict) -> dict:
        body = {k: workflow[k] for k in ("name", "nodes", "connections", "settings") if k in workflow}
        body.setdefault("settings", {})
        return self._request("PUT", f"/workflows/{workflow_id}", payload=body)


def main() -> int:
    """Connectivity check: python scripts/n8n_api.py"""
    try:
        client = N8nClient()
        workflows = client.list_workflows()
    except N8nError as exc:
        print(f"FAIL  {exc}", file=sys.stderr)
        return 1
    print(f"OK  connected to {client.base_url}")
    print(f"    {len(workflows)} workflow(s) visible to this API key")
    for w in workflows[:40]:
        print(f"    {w.get('id'):<20} {'active' if w.get('active') else 'inactive':<9} {w.get('name')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
