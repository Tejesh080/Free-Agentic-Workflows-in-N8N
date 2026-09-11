# Contracts

Four boundaries, each with a schema in `src/lib/schemas.ts` that is strict —
unknown keys are rejected, not dropped.

---

## 1. Public API: `POST /v1/leads`

```http
POST /v1/leads
Authorization: Bearer rsk_live_<16hex>_<43chars>
Content-Type: application/json

{
  "email": "dana@acme.example",
  "first_name": "Dana",
  "company_name": "Acme Robotics",
  "job_title": "VP Engineering",
  "notes": "Budget approved for this quarter; I own the decision.",
  "source": "website_form",
  "idempotency_key": "form-submission-4417",
  "dry_run": true
}
```

```http
202 Accepted
{
  "status": "accepted",
  "lead_id": "lead_9fK2xQ7rTm4w",
  "trace_id": "trc_a1B2c3D4e5F6",
  "dry_run": true,
  "allowed_actions": ["crm_write", "outreach_draft"]
}
```

**There is no `org_id` or `tenant_id` field.** Sending one is a `400`, because
the schema is strict. A caller who believes they can name their own organization
should be told they cannot, rather than have the field quietly ignored.

**`dry_run` narrows, never widens.** The effective mode is
`requested || organization.automation_level === 'dry_run'`. On a `dry_run`
organization, `"dry_run": false` still yields a dry run and
`allowed_actions: []`. Raising the ceiling is an admin action on the
organization, and the RLS policy refuses it to a machine principal.

**Idempotency.** `idempotency_key` is scoped to the authenticated organization by
a unique index on `(org_id, idempotency_key)`, so two organizations using the
same value never collide. Omit it and the server derives one from a digest of the
meaningful payload: a byte-identical resend converges on the original execution,
and a genuinely changed payload starts a new run against the same lead.

A replay answers `200` with `"status": "duplicate"` and the original `trace_id`,
so a client that retried on a timeout ends up with one run rather than two.

### Other endpoints

| Method and path | Notes |
| --- | --- |
| `GET /v1/leads` | Keyset paginated on `created_at`; an offset would drift as leads arrive |
| `GET /v1/leads/{publicId}` | The whole decision trace in one call. Internal primary keys are stripped from the response |
| `POST /v1/leads/{publicId}/outcomes` | The closed loop's input |
| `GET /v1/executions/{traceId}` | System trace plus receipt. No engine execution id and no engine URL |
| `GET /v1/approvals` | `is_expired` is computed on read, never trusted from storage |
| `POST /v1/approvals/{id}/approve` \| `/reject` | Requires a signed-in human; the RLS policy refuses a machine principal |

A lead in another organization and a lead that never existed both return `404`
with an identical body. The API must not be usable to confirm that somebody
else's record exists.

---

## 2. Dispatch: control plane → engine

```http
POST {N8N_INGEST_WEBHOOK_URL}
x-swarm-ingest-key: {SWARM_INGEST_KEY}
x-swarm-signature: v1=<hmac>
x-swarm-timestamp: 1789148797
x-swarm-nonce: <16 bytes base64url>

{
  "trace_id": "trc_a1B2c3D4e5F6",
  "execution_id": "9f2c…",
  "organization_id": "1db1…",
  "lead": { "id": "…", "public_id": "lead_…", "email": "…", "notes": "…", … },
  "rubric_version": "1.2.0",
  "rubric_version_id": "8a3f…",
  "dry_run": true,
  "allowed_actions": ["crm_write", "outreach_draft"],
  "callback_url": "https://…/api/internal/executions/trc_a1B2c3D4e5F6/complete"
}
```

`organization_id` is **execution data, not authority**. It scopes the engine's
own per-tenant state and appears in its logs. The engine is never asked to decide
whether the caller may act on that organization; that was settled before the
payload was built.

`allowed_actions` inverts the usual arrangement. Rather than the engine deciding
what it may do and the API trusting the answer, the API states the ceiling and
the engine may only narrow it. An engine that reported doing something outside
this list would be reporting a bug.

Two credentials, because they fail differently. `SWARM_INGEST_KEY` is the shared
ingress secret that stops an unauthenticated internet caller. The HMAC binds
*this* payload to *this* endpoint at *this* time, and stops a captured request
being replayed or edited. Dispatch **fails closed**: with any of the webhook URL,
ingest key or signing secret unset, `dispatchExecution` returns
`not_configured` and names the missing variable without printing its value.

---

## 3. Callback: engine → control plane

```http
POST /api/internal/executions/{traceId}/complete
x-swarm-signature: v1=<hmac>
x-swarm-timestamp: 1789148809
x-swarm-nonce: <16 bytes base64url>

{
  "status": "succeeded",
  "decision": "qualified",
  "score": 87,
  "tier": "HOT",
  "rubric_version": "1.2.0",
  "prompt_versions": { "revenue/lead-qualifier": "7b1c4e9" },
  "model_metadata": { "provider": "openai", "model": "gpt-5-mini", "reasoning_effort": "low" },
  "score_components": [{ "signal": "budget", "value": "approved", "points": 25, "supported": true }],
  "evidence": [{ "signal": "budget", "value": "approved", "quote": "…", "supported": true, "points": 25 }],
  "verification": { "supported": 4, "total": 4 },
  "governance": { "risk_level": "HIGH", "decision": "escalate", "reason": "…" },
  "actions_taken": [{ "action": "crm_upsert_contact", "object_id": "sim-contact-…" }],
  "actions_skipped": [{ "action": "outreach_send", "reason": "automation level is outreach_draft" }],
  "approval": { "required": true, "action": "outreach_send", "risk_level": "HIGH", "policy_reason": "…", "payload": {…} }
}
```

**It carries no organization and no lead id, and the schema rejects both.** The
server already knows them from the execution it dispatched; accepting them would
make the callback an authorization surface. `app.resolve_callback_target(trace_id)`
is a security-definer function that answers only with what we recorded.

**Every skipped action requires a non-empty `reason`.** A skipped step with no
reason is a missing audit record, so the schema refuses it.

### The signing scheme

```
v1:{METHOD}:{path}:{timestamp}:{nonce}:{sha256hex(raw body bytes)}
```

Each component earns its place:

- **method and path** bind the signature to one endpoint, so a signature captured
  from `trc_a1`'s completion cannot be replayed against `trc_b1`
- **timestamp** bounds how long a captured request stays usable (±300s)
- **nonce** makes a request single-use once recorded
- **digest of raw bytes** binds the signature to the exact payload, including key
  order and whitespace

The digest is taken over the bytes as received, never over a parsed and
re-serialised object. That is the classic way a signature check passes while the
handler acts on different data, and `bodyDigest` is unit-tested to differ between
two semantically identical JSON strings with different key order.

### Order of the checks, which is the design

1. **Verify the signature.** An unsigned or mis-signed request is refused before
   anything is looked up, so this endpoint cannot be used to discover which trace
   ids exist.
2. **Parse and validate** the payload.
3. **Resolve the execution**, and take the organization from the row we stored.
4. **Record the nonce, then apply**, both inside one transaction under that
   organization's context — so a replay cannot interleave with the state change
   it is duplicating, and every write is still checked by RLS.

### Failure semantics

| Situation | Response |
| --- | --- |
| No `N8N_CALLBACK_SECRET` configured | `401` — fails closed, and logs that the secret is missing |
| Bad signature, missing headers, stale or future timestamp | `401`, one identical message for all of them |
| Unknown `trace_id` | `404` |
| Nonce already recorded | `409 replayed`, state untouched |
| Execution already terminal, fresh nonce | `200 already_complete`, state untouched, delivery still recorded |
| Valid, first delivery | `200 recorded` with the receipt id |

The "already terminal" case is the one worth stating: a legitimate engine retry
with a fresh nonce must not be able to overwrite a finished decision. The test
`a second completion with a fresh nonce cannot overwrite a finished decision`
sends a second payload claiming score 100 and asserts the stored receipt is still
87, and that exactly one receipt exists.

---

## 4. Approval continuation: what is *not* built

When governance holds an action, the engine reports `approval.required` and
stops. A human decides in the dashboard. The authorized action then has to
actually run, and **the engine half of that is not built.**

`POST /v1/approvals/{id}/approve` therefore answers with
`"action_executed": false`, which is the truth rather than a placeholder.

The intended contract, so the seam is unambiguous:

```
POST {N8N_CONTINUATION_WEBHOOK_URL}     (same two credentials as dispatch)
{
  "approval_id": "…",
  "trace_id": "trc_…",
  "organization_id": "…",
  "action": "outreach_send",
  "payload": { … }          ← the frozen payload, byte for byte
}
```

The engine performs the action and calls back; the control plane calls
`recordApprovalExecution(approvalId, result)`, which succeeds only while the
request is `approved` and `executed_at` is null. That last condition is enforced
by the `guard_approval_transition` trigger and tested: an action can be recorded
against an approval exactly once, and never against a rejected one.

The frozen `payload_digest` is what makes this safe to defer. An approval cannot
be harvested and later applied to different content, because the database refuses
any change to the payload after the request is created.
