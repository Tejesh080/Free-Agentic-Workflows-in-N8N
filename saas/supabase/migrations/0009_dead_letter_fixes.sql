-- 0009_dead_letter_fixes.sql
-- Two corrections to 0008, both found by tests rather than by review.
--
-- 0008 is left alone: it has been applied, and the deploy script treats an
-- edited applied migration as an error because it means the deployed schema and
-- the repository have silently diverged.

-- ---------------------------------------------------------------------------
-- 1. The timeline view leaked across organizations.
-- ---------------------------------------------------------------------------
--
-- A Postgres view runs with the privileges of its OWNER unless told otherwise.
-- The owner here is the migration role, which is not subject to the policies on
-- dead_letters, executions and leads — so selecting through the view returned
-- every organization's rows regardless of who asked. RLS on the base tables was
-- working perfectly and being bypassed one level up.
--
-- security_invoker makes the view evaluate as the caller, so the same policies
-- apply through it as apply to the tables underneath.
--
-- Worth stating as a general rule: every view over a tenant-owned table needs
-- this, and the CI invariant added alongside this migration now enforces it.
create or replace view dead_letter_timeline with (security_invoker = true) as
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

-- ---------------------------------------------------------------------------
-- 2. Recording a replay's outcome is not the same action as authorising one.
-- ---------------------------------------------------------------------------
--
-- 0008 gave dead_letters a single UPDATE policy requiring a human member,
-- which is right for "I have decided to retry this" — that spends money and may
-- touch a customer's CRM again. But it also blocked the completion callback
-- from recording how the replay turned out, which is a machine reporting a
-- fact, not a decision. The system principal has no membership, so the update
-- matched nothing and a recovered dead letter stayed marked 'replayed' forever.
--
-- Rather than widening the policy — which would also let a machine abandon a
-- dead letter — the one transition a machine legitimately makes gets its own
-- narrow, security-definer entry point.
create or replace function app.resolve_dead_letter(
  p_replay_execution uuid,
  p_succeeded boolean
)
returns integer
language plpgsql volatile security definer set search_path = public, pg_temp as $FN$
declare affected integer;
begin
  update dead_letters
     set status = case when p_succeeded then 'recovered'::dead_letter_status
                       else 'open'::dead_letter_status end,
         resolution = case when p_succeeded
                      then 'a replay execution completed successfully'
                      else 'the replay execution also failed; the dead letter is open again' end,
         resolved_at = case when p_succeeded then now() else null end
   -- Only ever the row that named this execution as its replay, and only from
   -- 'replayed'. It cannot reach into an open or already-resolved dead letter.
   where replay_execution_id = p_replay_execution
     and status = 'replayed';
  get diagnostics affected = row_count;
  return affected;
end $FN$;

revoke all on function app.resolve_dead_letter(uuid, boolean) from public;
grant execute on function app.resolve_dead_letter(uuid, boolean) to revenue_swarm_app;
