-- 0002_pipeline.sql
-- Leads, the executions that process them, the evidence a model produced, and
-- the immutable receipt that explains a decision after the fact.
--
-- Postgres is authoritative for all of it. n8n holds execution-local scratch
-- state only; see docs/N8N-STATE-MIGRATION.md for the inventory.

-- ---------------------------------------------------------------------------
-- Rubric versions: the scoring artifact a decision is reproducible against
-- ---------------------------------------------------------------------------

create type rubric_status as enum ('draft', 'published', 'archived');

create table rubric_versions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  version       text not null,
  status        rubric_status not null default 'draft',
  -- Declarative only. A customer configures weights and thresholds; they never
  -- upload logic, so there is nothing here to execute.
  definition    jsonb not null,
  notes         text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,
  archived_at   timestamptz,
  unique (org_id, version)
);
create index rubric_versions_org_status_idx on rubric_versions (org_id, status);

-- Exactly one published rubric per organization. Enforced by the database, not
-- by the code path that happens to publish.
create unique index rubric_versions_one_published
  on rubric_versions (org_id)
  where status = 'published';

-- A published rubric is an immutable artifact: decisions cite it by id, so its
-- content may never change underneath them. Status may still move to archived
-- (that is what rollback is), and notes stay editable.
create or replace function app.guard_rubric_immutability() returns trigger
language plpgsql as $FN$
begin
  if old.status = 'published' and new.definition is distinct from old.definition then
    raise exception 'rubric_version % is published and its definition is immutable', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.status = 'published' and new.version is distinct from old.version then
    raise exception 'rubric_version % is published and its version label is immutable', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.status = 'archived' and new.status = 'published' then
    raise exception 'rubric_version % is archived; publish a new version instead of resurrecting it', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $FN$;

create trigger rubric_versions_immutable
  before update on rubric_versions
  for each row execute function app.guard_rubric_immutability();

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

create type lead_tier as enum ('HOT', 'WARM', 'COLD', 'DISQUALIFIED');

create type lead_status as enum (
  'received',     -- persisted, not yet dispatched
  'processing',   -- an execution is running
  'qualified',    -- a run finished and produced a tier
  'failed',       -- every attempt failed; see executions.error
  'archived'
);

create table leads (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  -- Stable public identifier. Exposed in URLs and API responses so the internal
  -- primary key never has to be.
  public_id      text not null,
  -- Tenant-scoped natural key for ingest idempotency. Derived from the payload
  -- by the API, never supplied by the caller.
  dedupe_key     text not null,
  status         lead_status not null default 'received',
  source         text not null default 'api',
  email          text,
  first_name     text,
  last_name      text,
  company_name   text,
  job_title      text,
  phone          text,
  website        text,
  -- What the caller actually sent, retained verbatim for reproducibility.
  raw_payload    jsonb not null default '{}'::jsonb,
  notes          text,
  latest_score   integer check (latest_score between 0 and 100),
  latest_tier    lead_tier,
  latest_execution_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  unique (org_id, public_id),
  unique (org_id, dedupe_key)
);
create index leads_org_created_idx on leads (org_id, created_at desc);
create index leads_org_tier_idx on leads (org_id, latest_tier);
create index leads_org_status_idx on leads (org_id, status);

-- ---------------------------------------------------------------------------
-- Executions
-- ---------------------------------------------------------------------------

create type execution_status as enum (
  'queued',      -- persisted and accepted, dispatch not yet confirmed
  'dispatched',  -- the engine acknowledged the job
  'running',
  'succeeded',
  'failed',
  'dead_letter'  -- failed and moved to the DLQ for audited replay
);

create table executions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  lead_id           uuid references leads(id) on delete cascade,
  -- Globally unique so a callback can resolve an execution without first being
  -- told which organization it belongs to. The callback never carries org id.
  trace_id          text not null,
  -- Tenant-scoped: two organizations may legitimately use the same key value.
  idempotency_key   text not null,
  status            execution_status not null default 'queued',
  dry_run           boolean not null default true,
  -- Version references, so a result can be reproduced exactly.
  rubric_version_id uuid references rubric_versions(id) on delete restrict,
  prompt_versions   jsonb not null default '{}'::jsonb,
  model_metadata    jsonb not null default '{}'::jsonb,
  -- Engine coordinates. Implementation detail: not exposed on the public API.
  engine            text not null default 'n8n',
  engine_workflow_id text,
  engine_execution_id text,
  attempt           integer not null default 1 check (attempt >= 1),
  replay_of         uuid references executions(id) on delete set null,
  error             jsonb,
  queued_at         timestamptz not null default now(),
  dispatched_at     timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  latency_ms        integer,
  cost_usd          numeric(12, 6),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create unique index executions_trace_id_key on executions (trace_id);
create index executions_org_created_idx on executions (org_id, created_at desc);
create index executions_lead_idx on executions (lead_id);
create index executions_org_status_idx on executions (org_id, status);

alter table leads
  add constraint leads_latest_execution_fk
  foreign key (latest_execution_id) references executions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

-- One row per constrained signal the model returned. `quote` is the verbatim
-- span the model cited; `supported` is the deterministic verification result of
-- checking that span against the source text. An unsupported signal is kept,
-- not deleted: why a lead lost points is part of the audit trail.
create table lead_evidence (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  execution_id  uuid not null references executions(id) on delete cascade,
  signal        text not null,
  value         text not null,
  quote         text,
  source_field  text,
  supported     boolean not null default false,
  points        integer not null default 0,
  created_at    timestamptz not null default now()
);
create index lead_evidence_lead_idx on lead_evidence (lead_id, created_at desc);
create index lead_evidence_execution_idx on lead_evidence (execution_id);

-- ---------------------------------------------------------------------------
-- Decision receipts
-- ---------------------------------------------------------------------------

-- The product differentiator: one immutable record per execution explaining
-- what was evaluated, what was decided, and what was deliberately not done.
--
-- It stores auditable inputs, outputs and deterministic derivations. It does
-- not store hidden model reasoning: a chain of thought is neither verifiable
-- nor a decision input, so keeping it would add liability without evidence.
create table decision_receipts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  lead_id           uuid references leads(id) on delete cascade,
  execution_id      uuid not null references executions(id) on delete cascade,
  trace_id          text not null,
  decision          text not null,
  score             integer check (score between 0 and 100),
  tier              lead_tier,
  rubric_version_id uuid references rubric_versions(id) on delete restrict,
  rubric_version    text,
  prompt_versions   jsonb not null default '{}'::jsonb,
  model_metadata    jsonb not null default '{}'::jsonb,
  -- Deterministic score components: which weight fired, for which signal.
  score_components  jsonb not null default '[]'::jsonb,
  verification      jsonb not null default '{}'::jsonb,
  governance        jsonb not null default '{}'::jsonb,
  actions_taken     jsonb not null default '[]'::jsonb,
  -- Every skipped step carries its reason. A silent skip is a missing audit.
  actions_skipped   jsonb not null default '[]'::jsonb,
  crm_result        jsonb,
  created_at        timestamptz not null default now(),
  unique (execution_id)
);
create index decision_receipts_org_created_idx on decision_receipts (org_id, created_at desc);
create index decision_receipts_lead_idx on decision_receipts (lead_id);
create unique index decision_receipts_trace_key on decision_receipts (trace_id);

-- A receipt is append-only. Correcting one means issuing a new execution, not
-- editing history.
create or replace function app.deny_mutation() returns trigger
language plpgsql as $FN$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, lower(tg_op)
    using errcode = 'integrity_constraint_violation';
end $FN$;

create trigger decision_receipts_append_only
  before update or delete on decision_receipts
  for each row execute function app.deny_mutation();

-- ---------------------------------------------------------------------------
-- Callback deliveries: replay protection for the engine -> SaaS callback
-- ---------------------------------------------------------------------------

-- The signed nonce of every accepted callback. A replayed request presents a
-- nonce that is already here and is refused before it can touch execution
-- state, so a captured valid callback cannot be used twice.
create table callback_deliveries (
  id            uuid primary key default gen_random_uuid(),
  -- Denormalised from the execution on purpose: an RLS policy that had to read
  -- executions to find the owner would be subject to that table's own policy,
  -- so the owner is stored where the policy can see it directly.
  org_id        uuid not null references organizations(id) on delete cascade,
  execution_id  uuid not null references executions(id) on delete cascade,
  nonce         text not null,
  signed_at     timestamptz not null,
  body_digest   text not null,
  received_at   timestamptz not null default now(),
  unique (nonce)
);
create index callback_deliveries_execution_idx on callback_deliveries (execution_id);

create trigger callback_deliveries_append_only
  before update or delete on callback_deliveries
  for each row execute function app.deny_mutation();

create trigger rubric_versions_touch before update on rubric_versions for each row execute function app.touch_updated_at();
create trigger leads_touch           before update on leads           for each row execute function app.touch_updated_at();
create trigger executions_touch      before update on executions      for each row execute function app.touch_updated_at();
