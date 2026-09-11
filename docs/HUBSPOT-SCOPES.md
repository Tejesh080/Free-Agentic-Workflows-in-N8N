# HubSpot scopes: derived from the execution graph

Not a generic list. Every row below was read out of the n8n HubSpot node source
(`packages/nodes-base/nodes/Hubspot/V2/HubspotV2.node.ts`) against workflow 11's
actual node configuration, so it describes the calls this system makes and no
others.

Workflow 11 is the only workflow in the platform that talks to HubSpot.

## Calls actually made

| Operation | HTTP call | Action | Scope required | Why |
| --- | --- | --- | --- | --- |
| `upsert_contact` | `POST /contacts/v1/contact/createOrUpdate/email/{email}` | write | `crm.objects.contacts.write` | Creates or updates the contact and writes `swarm_lead_score` and `swarm_lead_tier` in the same call |
| `create_deal` | `POST /deals/v1/deal` | write | `crm.objects.deals.write` | Creates the deal. The contact association travels **inside** this payload as `associations.associatedVids`, so it needs no separate associations call and no associations scope |
| `create_task` | `POST /engagements/v1/engagements` | write | `crm.objects.tasks.write` — see note | Creates the follow-up task carrying the scoring rationale, with `associations.contactIds` in the same payload |

**That is the complete list. Three calls, all writes, no reads.**

## Scopes deliberately NOT requested

| Scope | Why it is not needed |
| --- | --- |
| `crm.objects.contacts.read` | **It was needed until this audit.** The node's branch is `if (!options.resolveData)` — inverted relative to its own description — so with `resolveData: false` it made a second call, `GET /contacts/v1/contact/vid/{vid}/profile`. Setting `resolveData: true` returns `{vid, isNew}` from the upsert, which is all `Capture Contact Write` reads. One fewer call, one fewer scope |
| `crm.objects.owners.read` | `getOwners` is a `@loadOptionsMethod`. Load-options run in the **n8n editor** to populate a dropdown; they never run during execution. `dealOwner` is not set by the orchestrator |
| Pipeline / deal-stage read | `getDealStages` is also load-options only. `stage` arrives as a literal string from workflow 14 (`options.deal_stage`, default `qualifiedtobuy`) |
| `crm.schemas.contacts.read` / `.write` | The workflow *writes values to* two custom properties. It never *creates* a property — you create those once in the HubSpot UI |
| `crm.objects.companies.*` | No company object is ever created. `associatedCompanyId` is never set, so the `PUT /crm-associations/v1/associations/create-batch` branch never executes |
| Any `.delete` scope | The service supports three operations and none of them is a delete. The switch fallback refuses anything else before a request is built |
| Contact **search** | Worth stating explicitly because it is the usual reason an upsert needs a read scope: there is no search anywhere in workflow 11. `createOrUpdate/email/{email}` resolves the existing record server-side, in one call |

## The one I could not verify from a primary source

The legacy `POST /engagements/v1/engagements` endpoint predates HubSpot's
granular scope model, and I could not confirm its exact Private App scope
mapping from HubSpot's own documentation. `crm.objects.tasks.write` is the
modern scope for the task object and is the most likely requirement.

Rather than over-grant to be safe, do this:

1. Create the Private App with `crm.objects.contacts.write` and
   `crm.objects.deals.write` only.
2. Run one `create_task` against your sandbox portal.
3. If it returns `403`, HubSpot's error body names the **exact** missing scope.
   Add that one and nothing else.

A 403 costs you thirty seconds. An over-scoped token is a standing liability.

## Setting it up

1. HubSpot → Settings → Integrations → Private Apps → **Create a private app**.
2. Grant the scopes above.
3. Copy the token into n8n → Credentials → new **HubSpot App Token**.
4. Attach it to the three nodes in workflow 11 and **enable** them (they ship
   disabled, and CI fails if a published export has them enabled).
5. Create two contact properties in HubSpot → Settings → Properties:
   `swarm_lead_score` (number) and `swarm_lead_tier` (single-line text).

Do not paste the token into a chat, a commit, or an issue. Create it in the n8n
credential UI directly; nothing in this repository needs to see its value.

## Blast radius if the token leaks

With exactly these scopes, an attacker holding the token can create and update
contacts, create deals, and create tasks in that one portal. They cannot read
your contact database, cannot delete anything, cannot touch companies, tickets,
marketing email or files, and cannot reach any other portal.

That is a meaningfully smaller hole than the `crm.objects.contacts.read` +
`crm.objects.owners.read` + `crm.schemas.contacts.read` set this document
replaced — which, in particular, would have let a leaked token **read every
contact record in the portal**.
