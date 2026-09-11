-- 0008_dead_letters.sql
-- The control plane's own record of a failed run.
--
-- Not a copy of n8n's error system. n8n knows that a workflow crashed and where;
-- it does not know that a customer's lead never got processed, which is the
-- thing a product has to answer. Workflow 16 stays exactly as it is — it is the
-- engine's dead-letter log and its audited replay path. This is the SaaS view:
-- correlate the original execution, the failure, the replay attempt, and how it
-- ended.
--
-- The central rule: a failure record is never overwritten. A replay does not
-- edit the failure it came from; it links a new execution to it. So a lead that
-- failed three times has three rows, and the history of what went wrong is
-- still readable after it eventually succeeds.

create type dead_letter_status as enum (
  'open',       -- failed, nothing done about it yet
  'replayed',   -- a replay execution was created; its outcome is not yet known
  'recovered',  -- a replay succeeded
  'abandoned'   -- a human decided not to retry
);

create type failure_stage as enum (
  'dispatch',   -- the control plane could not hand the job over
  'engine',     -- the engine accepted it and then failed
  'callback'    -- the engine finished but reported a failure
);

create table dead_letters (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- The execution that failed. Immutable: this row is *about* that attempt.
  execution_id        uuid not null references executions(id) on delete cascade,
  lead_id             uuid references leads(id) on delete cascade,
  trace_id            text not null,
  stage               failure_stage not null,
  -- Whatever the failing layer said, verbatim. Never summarised into a string:
  -- the shape of an error is part of diagnosing it.
  error               jsonb not null,
  failing_node        text,
  engine_execution_id text,
  engine_execution_url text,
  attempt             integer not null default 1 check (attempt >= 1),

  status              dead_letter_status not null default 'open',
  -- A replay is a NEW execution, pointed at from here. executions.replay_of
  -- points the other way, so the chain is navigable from either end.
  replay_execution_id uuid references executions(id) on delete set null,
  replayed_at         timestamptz,
  replayed_by         uuid references users(id) on delete set null,
  resolved_at         timestamptz,
  resolution          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index dead_letters_org_status_idx on dead_letters (org_id, status, created_at desc);
create index dead_letters_execution_idx on dead_letters (execution_id);
create index dead_letters_lead_idx on dead_letters (lead_id);
create index dead_letters_trace_idx on dead_letters (trace_id);

-- One dead letter per failed execution. A second failure of the *same*
-- execution is the same failure; a retry creates a new execution and therefore
-- a new row if it fails too.
create unique index dead_letters_one_per_execution on dead_letters (execution_id);

-- What happened is immutable; what was done about it is not.
create or replace function app.guard_dead_letter() returns trigger
language plpgsql as $FN$
begin
  if new.execution_id is distinct from old.execution_id
     or new.org_id is distinct from old.org_id
     or new.trace_id is distinct from old.trace_id
     or new.stage is distinct from old.stage
     or new.error is distinct from old.error
     or new.failing_node is distinct from old.failing_node
     or new.attempt is distinct from old.attempt
     or new.created_at is distinct from old.created_at then
    raise exception 'dead_letter % records what failed; that record is immutable', old.id
      using errcode = 'integrity_constraint_violation',
            hint = 'a replay links a new execution to this row; it does not edit it';
  end if;

  -- A replay must name the execution it created, and cannot be un-named later.
  if new.status = 'replayed' and new.replay_execution_id is null then
    raise exception 'dead_letter % cannot be marked replayed without a replay execution', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.replay_execution_id is not null
     and new.replay_execution_id is distinct from old.replay_execution_id then
    raise exception 'dead_letter % already points at a replay execution', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.status in ('recovered', 'abandoned') and new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end $FN$;

create trigger dead_letters_guard
  before update on dead_letters
  for each row execute function app.guard_dead_letter();

create trigger dead_letters_touch
  before update on dead_letters
  for each row execute function app.touch_updated_at();

alter table dead_letters enable row level security;
alter table dead_letters force row level security;

create policy dead_letters_read on dead_letters
  for select using (app.has_org_access(org_id));

create policy dead_letters_insert on dead_letters
  for insert with check (app.has_org_access(org_id));

-- Deciding to replay or abandon is a human judgement about spending money and
-- touching a customer's CRM again, so it is not open to a machine principal.
create policy dead_letters_member_update on dead_letters
  for update using (
        app.has_org_access(org_id)
        and app.org_role(org_id) in ('owner', 'admin', 'member')
      )
      with check (
        app.has_org_access(org_id)
        and app.org_role(org_id) in ('owner', 'admin', 'member')
      );

grant select, insert, update on dead_letters to revenue_swarm_app;

-- ---------------------------------------------------------------------------
-- A view that answers the question the product actually asks
-- ---------------------------------------------------------------------------

-- "Which leads are stuck, and what happened to them?" — the original failure,
-- the replay if there was one, and how that ended, in one row.
create or replace view dead_letter_timeline as
select
  d.id                       as dead_letter_id,
  d.org_id,
  d.trace_id                 as original_trace_id,
  d.stage,
  d.error,
  d.status,
  d.created_at               as failed_at,
  l.public_id                as lead_id,
  l.email                    as lead_email,
  orig.status                as original_execution_status,
  orig.attempt               as original_attempt,
  replay.trace_id            as replay_trace_id,
  replay.status              as replay_execution_status,
  d.replayed_at,
  d.resolved_at,
  d.resolution
from dead_letters d
join executions orig on orig.id = d.execution_id
left join executions replay on replay.id = d.replay_execution_id
left join leads l on l.id = d.lead_id;

grant select on dead_letter_timeline to revenue_swarm_app;
