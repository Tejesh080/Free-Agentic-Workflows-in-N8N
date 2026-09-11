# HubSpot: API choice and least-privilege scopes

Derived from the final execution graph of workflow 11, which is the only workflow
in the platform that talks to HubSpot. Every row below corresponds to a request
the graph actually issues. Nothing is listed because it seemed prudent.

## Which API, and why it changed

The previous implementation used n8n's native HubSpot node (`typeVersion` 2.2).
Reading that node's source rather than its documentation shows which endpoints it
actually calls:

| Node operation | Endpoint it issues | Source |
| --- | --- | --- |
| contact: upsert | `POST /contacts/v1/contact/createOrUpdate/email/{email}` | `HubspotV2.node.ts:1529` |
| contact: upsert, with `resolveData: false` | plus `GET /contacts/v1/contact/vid/{vid}/profile` | `HubspotV2.node.ts:1548-1558` |
| deal: create | `POST /deals/v1/deal` | `HubspotV2.node.ts:2386` |
| engagement: create | `POST /engagements/v1/engagements` | `HubspotV2.node.ts:2695` |
| contact: upsert, with `associatedCompanyId` | plus `PUT /crm-associations/v1/associations/create-batch` | `HubspotV2.node.ts:1545` |

Those numeric `v1` paths are HubSpot's oldest generation. Meanwhile HubSpot has
moved to **date-based versioning**: versions ship each March and September, each
gets 18 months of guaranteed support, and the current GA version is `2026-09`
with paths shaped `/crm/objects/2026-09/{objectType}`. The semantic `v3` and `v4`
endpoints are now labelled *Legacy* and are scheduled to become unsupported at
HubSpot's Spring Spotlight '27. The `v1` endpoints the native node uses sit a
generation behind even those.

HubSpot's own migration guidance is that new development should default to the
date-based versions and that the version should be configuration-driven rather
than hard-coded.

**Decision: replace the internals of workflow 11 with HTTP Request nodes against
`/crm/objects/{api_version}/`, default `2026-09`, overridable per request.**

The service contract did not change. Callers still send
`{op, payload, tenant_id, trace_id, idempotency_key, dry_run}` and still receive
`{ok, op, object_type, object_id, status, replayed, simulated, errors, …}`.
Workflows 12–16 saw no change at all, which is the point of having the boundary.

### What the change actually buys

Not "it is newer". Specifically:

- **A supported API lifecycle.** The version is now a value in the request
  (`payload.api_version`), validated against `^\d{4}-\d{2}$`. Moving to `2027-03`
  is a configuration change, not a node rewrite.
- **Explicit associations.** The legacy deal create carried the contact link as
  `associations.associatedVids`, a shape specific to that endpoint. The 2026-09
  create carries `associations: [{to:{id}, types:[{associationCategory:
  "HUBSPOT_DEFINED", associationTypeId: 3}]}]` — the same single call, but the
  relationship is named rather than implied. Task→contact uses `204`.
- **Usable errors.** The current API returns a structured body with a `category`
  (for example `MISSING_SCOPES`), which is what makes the scope-discovery
  procedure below deterministic instead of guesswork.
- **The mapping is readable.** Request construction moved out of node expressions
  into `Normalise CRM Request`, as ordinary JavaScript. A consequence worth
  having: the dry-run branch now returns `planned_request` — the exact method,
  URL and body the live branch would have issued — so the mapping is auditable
  without a credential existing.
- **One fewer moving part per write.** The upsert is a single
  `contacts/batch/upsert` call with `idProperty: "email"`. HubSpot has no
  single-object upsert; the alternative is create-then-patch-on-conflict, which
  needs a read to learn the id.

### What it does not buy

HubSpot publishes no idempotency-key header on these endpoints. Replay safety is
still ours: the tenant-scoped write ledger in workflow 11 is checked before the
CRM, so a repeated `idempotency_key` returns the first write's id without issuing
a second request. That was true before this change and is unchanged by it.

## Calls the graph makes

| Operation | Request | Scope required | Why |
| --- | --- | --- | --- |
| `upsert_contact` | `POST /crm/objects/2026-09/contacts/batch/upsert` | `crm.objects.contacts.write` | Creates or updates the contact by email and writes `swarm_lead_score` and `swarm_lead_tier` in the same call |
| `create_deal` | `POST /crm/objects/2026-09/deals` | `crm.objects.deals.write` | Creates the deal; the contact association travels in the same body, so no separate associations request and no associations scope |
| `create_task` | `POST /crm/objects/2026-09/tasks` | `crm.objects.contacts.write` **and** `crm.objects.contacts.read` | Creates the follow-up task carrying the scoring rationale, associated to the contact inline |

**Default deployment: two scopes, both writes, no reads.**

```
crm.objects.contacts.write
crm.objects.deals.write
```

## The task operation costs a read scope

This is a correction to the previous version of this document, which guessed
`crm.objects.tasks.write`.

HubSpot's tasks reference states the required scopes for the tasks endpoint as
`crm.objects.contacts.read` and `crm.objects.contacts.write`. And
`crm.objects.tasks.write` appears not to be a recognised private-app scope at
all — developers report it rejected at deploy time with "the scope could not be
recognized", and it is absent from the scopes reference.

So enabling `create_task` means granting **read access to every contact in the
portal**. That is a materially larger blast radius than the other two operations
combined, for the sake of a follow-up reminder.

Consequently `create_task` is **off by default**: workflow 14 does not request
it, and the integration record carries `create_task: false` with the reason
attached. The operation stays implemented, because turning it on should be a
decision with a stated price rather than a feature that has to be rebuilt.

## Scopes deliberately not requested

| Scope | Why it is not needed |
| --- | --- |
| `crm.objects.contacts.read` | Not needed for the two default operations. The batch upsert returns `results[0].id`, which is all `Capture Contact Write` reads. Required only if `create_task` is enabled — see above. |
| `crm.objects.owners.read` | The native node's `getOwners` was a `@loadOptionsMethod`: it ran in the n8n editor to fill a dropdown, never during execution. The HTTP implementation has no such call at all, and `hubspot_owner_id` is never set. |
| Pipeline / deal-stage read | `dealstage` arrives as a literal string from workflow 14 (`options.deal_stage`, default `qualifiedtobuy`). Nothing reads the pipeline definition at run time. |
| `crm.schemas.contacts.read` / `.write` | The workflow *writes values to* two custom properties. It never *creates* a property; you create those once in the portal. |
| `crm.objects.companies.*` | No company object is created or associated. The legacy node had a company-association branch; the replacement has no company code path to reach. |
| Associations scope | Both associations travel inside their create call. There is no request to `/associations/`. |
| Any `.delete` scope | The service supports three operations and none is a delete. The switch fallback refuses anything else before a request is built. |
| Contact **search** | Worth stating because it is the usual reason an upsert needs a read scope: there is no search anywhere in workflow 11. `batch/upsert` with `idProperty: "email"` resolves the existing record server-side. |

## Setting it up

1. HubSpot → Settings → Integrations → Private Apps → **Create a private app**.
2. Grant exactly `crm.objects.contacts.write` and `crm.objects.deals.write`.
3. In n8n → Credentials → new **HubSpot App Token**, paste the token there.
   Do not paste it into a chat, a commit, or an issue. Nothing in this
   repository needs to see its value.
4. Attach the credential to the three HTTP Request nodes in workflow 11 and
   **enable** them. They ship `disabled: true` because a node with a missing
   required credential blocks publishing, and an unpublished sub-workflow cannot
   be called from a nested execution.
5. Create two contact properties in HubSpot → Settings → Properties:
   `swarm_lead_score` (number) and `swarm_lead_tier` (single-line text).
   **Verified 2026-09-12 against the connected portal: neither exists yet.** The
   upsert will fail until they do.

### If a call returns 403

Do not widen the grant to make it pass. The response body names the missing
scope under `category: "MISSING_SCOPES"`. Add that one scope and nothing else.
A 403 costs you thirty seconds; an over-scoped token is a standing liability.

## Blast radius if the token leaks

With exactly the two default scopes, an attacker holding the token can create and
update contacts, and create deals, in one portal. They cannot read your contact
database, cannot delete anything, cannot touch companies, tickets, marketing
email or files, and cannot reach any other portal.

Enabling `create_task` adds `crm.objects.contacts.read`, which turns the same
leaked token into a full export of every contact record. That is the trade the
setting exists to make visible.

## Status of live verification

**Not verified against a live portal.** No HubSpot credential exists on the n8n
instance, so the three HTTP calls have never been executed. What *is* verified:

- Workflow 11's suite passes 10/10 after the change (execution `901`), covering
  validation rejection, tenant-scoped replay, cross-tenant isolation, the switch
  fallback, and all three dry-run paths.
- The dry-run branch emits `planned_request` for each operation, so the exact
  URL, method and body are inspectable in that execution's output.
- Endpoint paths, association type ids and the tasks scope requirement are taken
  from HubSpot's own reference rather than from the n8n node's documentation.

The remaining unknown is HubSpot's runtime behaviour: whether the batch-upsert
response includes a `new` flag (the capture node reads it if present and reports
`is_new: null` if not, rather than guessing), and the exact scope error for
`create_task`.
