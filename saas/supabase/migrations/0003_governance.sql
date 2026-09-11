-- 0003_governance.sql
-- Approvals, outcomes, evaluation runs, integrations and the audit log.
--
-- Approval state lives here and nowhere else. A notification transport (Slack,
-- Telegram, email, the dashboard) may carry the request and collect the click,
-- but the transport never owns the decision.

-- ---------------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------------

create type approval_status as enum ('pending', 'approved', 'rejected', 'expired');

create type approval_action as enum (
  'outreach_send',
  'crm_write',
  'rubric_publish',
  'automation_level_change'
);

create table approval_requests (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  lead_id        uuid references leads(id) on delete cascade,
  execution_id   uuid references executions(id) on delete set null,
  trace_id       text,
  action         approval_action not null,
  status         approval_status not null default 'pending',
  risk_level     text not null default 'MEDIUM'
                 check (risk_level in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  -- Why a human is being asked, in the words of the policy that asked.
  policy_reason  text not null,
  -- The exact payload the action will use if approved. Frozen at request time so
  -- an approval cannot be harvested and then applied to different content.
  payload        jsonb not null default '{}'::jsonb,
  payload_digest text not null,
  requested_at   timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '24 hours'),
  decided_at     timestamptz,
  decided_by     uuid references users(id) on delete set null,
  decision_note  text,
  -- Set once the authorized action actually ran, so an approval can be told
  -- apart from an execution of it.
  executed_at    timestamptz,
  execution_result jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index approval_requests_org_status_idx on approval_requests (org_id, status, requested_at desc);
create index approval_requests_lead_idx on approval_requests (lead_id);

-- Only one open request per action per execution, so a duplicate notification
-- cannot become a second usable authorization.
create unique index approval_requests_one_pending
  on approval_requests (org_id, coalesce(execution_id, '00000000-0000-0000-0000-000000000000'::uuid), action)
  where status = 'pending';

-- The state machine, enforced in the database. pending is the only state a
-- decision can be made from, and a decided request is terminal.
create or replace function app.guard_approval_transition() returns trigger
language plpgsql as $FN$
begin
  if old.status <> 'pending' and new.status <> old.status then
    raise exception 'approval_request % is already %; it cannot move to %', old.id, old.status, new.status
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.payload_digest is distinct from old.payload_digest then
    raise exception 'approval_request % payload is frozen at request time', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.status in ('approved', 'rejected') and new.decided_at is null then
    new.decided_at := now();
  end if;
  -- An action may only run against an approval that is currently approved.
  if new.executed_at is not null and old.executed_at is null and new.status <> 'approved' then
    raise exception 'approval_request % is %; an action cannot record execution against it', old.id, new.status
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.executed_at is not null and new.executed_at is distinct from old.executed_at then
    raise exception 'approval_request % has already been executed once', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $FN$;

create trigger approval_requests_transition
  before update on approval_requests
  for each row execute function app.guard_approval_transition();

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------

create type outcome_state as enum (
  'no_reply',
  'replied',
  'positive_reply',
  'meeting_booked',
  'opportunity_created',
  'won',
  'lost',
  'disqualified'
);

-- Append-only outcome observations. A lead's history is the sequence, not a
-- single mutable column, because evaluation needs to know when something became
-- true as well as that it is true.
create table lead_outcomes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  execution_id  uuid references executions(id) on delete set null,
  state         outcome_state not null,
  source        text not null default 'manual'
                check (source in ('manual', 'crm_sync', 'reply_ingest', 'api')),
  value_usd     numeric(14, 2),
  occurred_at   timestamptz not null default now(),
  recorded_by   uuid references users(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);
create index lead_outcomes_lead_idx on lead_outcomes (lead_id, occurred_at desc);
create index lead_outcomes_org_state_idx on lead_outcomes (org_id, state, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Evaluation
-- ---------------------------------------------------------------------------

create table evaluation_runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- Which rubric was the incumbent and which was on trial. Both are real
  -- rubric rows, so a run can be re-read years later and still mean something.
  production_rubric_id uuid references rubric_versions(id) on delete restrict,
  candidate_rubric_id  uuid references rubric_versions(id) on delete restrict,
  dataset_version     text not null,
  dataset_size        integer not null check (dataset_size >= 0),
  -- Named so the sampling that produced a result can be repeated exactly.
  sample_seed         text,
  segment             text,
  production_metrics  jsonb not null default '{}'::jsonb,
  candidate_metrics   jsonb not null default '{}'::jsonb,
  -- The gate's own output, not a summary of it.
  gate_decision       text not null check (gate_decision in ('promote', 'reject', 'inconclusive')),
  gate_reasons        jsonb not null default '[]'::jsonb,
  engine_execution_id text,
  created_by          uuid references users(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index evaluation_runs_org_created_idx on evaluation_runs (org_id, created_at desc);

create trigger evaluation_runs_append_only
  before update or delete on evaluation_runs
  for each row execute function app.deny_mutation();

-- ---------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------

-- Metadata only. No credential value is ever stored in this database: the
-- secret lives in the execution engine's credential store, and this row records
-- that it exists, what it is scoped to, and whether it last worked.
create table integrations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  provider       text not null check (provider in ('hubspot')),
  status         text not null default 'disconnected'
                 check (status in ('disconnected', 'connected', 'error')),
  external_account_id text,
  granted_scopes text[] not null default '{}',
  -- Opaque handle into the engine's credential store. Not a secret itself.
  credential_ref text,
  config         jsonb not null default '{}'::jsonb,
  last_success_at timestamptz,
  last_error      jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, provider)
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

-- Answers "who changed the rules", separately from the business trace (why a
-- lead was scored) and the system trace (what executed). Three questions, three
-- stores, correlated by trace id where they overlap.
create table audit_events (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  actor_type    text not null check (actor_type in ('user', 'api_key', 'system', 'engine')),
  actor_user_id uuid references users(id) on delete set null,
  actor_api_key_id uuid references api_keys(id) on delete set null,
  action        text not null,
  target_type   text not null,
  target_id     text,
  trace_id      text,
  -- Before/after for a configuration change. Never populated with secrets.
  before        jsonb,
  after         jsonb,
  request_ip    inet,
  created_at    timestamptz not null default now()
);
create index audit_events_org_created_idx on audit_events (org_id, created_at desc);
create index audit_events_target_idx on audit_events (org_id, target_type, target_id);

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function app.deny_mutation();

create trigger approval_requests_touch before update on approval_requests for each row execute function app.touch_updated_at();
create trigger integrations_touch      before update on integrations      for each row execute function app.touch_updated_at();
