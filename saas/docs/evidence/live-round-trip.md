# Live round trip — 2026-09-12

The first time a lead went from an authenticated API request to a real record in
a real CRM. Captured from the actual executions, not retyped.

## Objects created in HubSpot — for cleanup

Portal **443692798** (`Ichor premium supplements`), all with synthetic data at
IANA-reserved `example.com`, which cannot receive mail.

| Type | Id | Name / email | Score / tier | Created |
| --- | --- | --- | --- | --- |
| Contact | `352173146590` | `revenue-swarm-synthetic-probe-20260912@example.com` — Synthetic Probe | 90 / HOT | 18:59:58Z |
| Contact | `352245096934` | `e2e-synthetic-probe-20260912@example.com` — EndToEnd Probe | 26 / COLD | 19:15:02Z |
| Deal | `292324390346` | Revenue Swarm Synthetic Probe (DELETE ME) — inbound | `qualifiedtobuy`, pipeline `default`, 1 associated contact | 19:01:53Z |

**Tasks created: none.** `create_task` stayed disabled throughout, because that
endpoint additionally requires `crm.objects.contacts.read`.

Both contacts carry `(DELETE ME)` in the company name so they are obvious in a
list view. **Nothing was deleted automatically.**

### Configuration created, which is not test data

| Thing | Where | Keep or remove |
| --- | --- | --- |
| Contact property `swarm_lead_score` (number) | HubSpot → Properties | **Keep** — workflow 11 needs it |
| Contact property `swarm_lead_tier` (single-line text) | HubSpot → Properties | **Keep** — workflow 11 needs it |
| Credential `Revenue Swarm Ingest Key` (`httpHeaderAuth`) | n8n → Credentials | **Keep** — it is the public webhook's gate |

## The chain, with the identifiers

```
POST /api/v1/leads                              202 in 0.54s
  Authorization: Bearer rsk_live_…              organization resolved from the key
  body carries no org_id / tenant_id            (the schema rejects one)
        │
        ├─ lead persisted            lead_3KwsTCLlQDOvEUaK
        ├─ execution created         trace trc_euG2uKekxj5b9Yo0
        └─ dispatch → n8n            x-swarm-key + HMAC, 200
                │
                ▼
        n8n execution 1079  (workflow 14, entry=control_plane)
                │
                ├─ qualification         score 26, COLD, rubric 1.2.0
                ├─ evidence verified     deterministic_only, verified=true
                ├─ CRM via workflow 11   execution 1048/1049 → contact 352245096934
                ├─ deal                  skipped: "a deal is only opened for a HOT lead"
                ├─ task                  skipped_operation_disabled
                ├─ outreach              skipped: "score 26 is below the ICP outreach floor of 50"
                └─ callback built + signed, then BLOCKED by n8n's SSRF guard
                        │
                        ▼  (delivered by scripts/deliver-engine-callback.ts)
        POST /api/internal/executions/trc_euG2uKekxj5b9Yo0/complete   200
                └─ receipt 82c24a40-0ef0-4bf6-9a0d-d7f19f1b8223 persisted
                        │
                        ▼
        UI /leads/lead_3KwsTCLlQDOvEUaK renders the same values
```

## The one link that is not proven

The callback hop from n8n Cloud to the control plane. n8n refused it:

> The target 127.0.0.1 is not allowed. This is a security measure to prevent
> Server-Side Request Forgery (SSRF).

That is n8n's own egress protection working correctly, and it is the right
behaviour — the control plane is on a laptop. The engine **built and signed a
valid callback**; it could not deliver it.

`scripts/deliver-engine-callback.ts` reads the body the engine actually produced
out of that execution's stored `Build Callback` output and re-signs it with the
same per-execution key and a fresh timestamp — which is exactly what the engine
does on a retry. It does not invent a payload: if the engine never reached that
node, the script fails rather than making one up.

So the chain is proven end to end *except* that one network hop, which needs a
publicly reachable URL. Everything about the callback — the signature scheme,
the key derivation, replay rejection, terminal-state protection, cross-execution
isolation — is tested over real HTTP in `tests/http-boundary.test.ts`.

## Two bugs the live call found

Neither was visible to review; both needed a real API.

**HubSpot rejects `.test` addresses.** The first attempt used
`swarm-live-probe@revenueswarm.test`. RFC 2606 reserves `.test` and it is the
correct choice everywhere else in this repository — the secret scanner
allow-lists it for exactly that reason. HubSpot returned:

```
400 VALIDATION_ERROR
Email address swarm-live-probe@revenueswarm.test is invalid  (INVALID_EMAIL)
```

**The 2026-09 deals endpoint requires `pipeline`.** It is not inferred from
`dealstage`:

```
400 VALIDATION_ERROR
Cannot create object with type: DEAL. The following required properties were missing: [pipeline]
```

It now defaults to `default` and stays overridable per request. This is the
"better errors" argument for moving off the legacy API paying for itself: the
response named the missing property, so the fix took one line and no guessing.

## What the ingress gate did

`SWARM_INGEST_KEY` was read from `$vars`, and **n8n variables are a licensed
feature this instance does not have** — so the gate could never authenticate
anything. Execution `1033` recorded its own diagnosis:

```
ingest_authorised: false
ingest_reason: "the SWARM_INGEST_KEY variable is not set on this n8n instance,
                so no inbound lead can be authenticated"
```

Fail-closed, verified rather than asserted — and useless, because it refused
every legitimate lead too. It now uses n8n's own header auth with a credential,
enforced before any node runs. Against the production URL:

| Request | Result |
| --- | --- |
| no `x-swarm-key` | `403 Authorization data is wrong!` |
| wrong `x-swarm-key` | `403 Authorization data is wrong!` |
| correct `x-swarm-key` | `200`, pipeline ran |

## Outreach never fired

Required, and worth showing how rather than asserting it. The first probe
planted a quote in the signals that is deliberately absent from the lead's
message. Qualification caught it:

```
score 90, tier HOT, rubric 1.2.0
modifiers: unsupported_evidence -10
  "1 quoted piece(s) of evidence do not appear in the lead or the enrichment"
outreach_allowed: false
outreach_block_reason: "unsupported evidence"
requires_human_review: true
recommended_action: route_to_sales_after_review
```

So the run reached HOT — creating the deal, which is what the test needed — and
still refused outreach, through the product's own evidence rule rather than
through a flag. Workflow 13's Telegram transport was additionally disabled for
the duration of the probe as a belt-and-braces guard and has been restored; it
was never reached.
