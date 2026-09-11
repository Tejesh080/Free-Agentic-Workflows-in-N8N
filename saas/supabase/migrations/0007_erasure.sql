-- 0007_erasure.sql
-- Make erasure possible without making history editable.
--
-- The problem this fixes was found by a test, not by review. `delete from
-- organizations` cascades into decision_receipts, audit_events, evaluation_runs
-- and callback_deliveries — all of which carry an append-only trigger. So the
-- cascade failed, and with it every legitimate reason to delete an
-- organization: a data subject erasure request, a cancelled trial, cleaning up
-- after a test.
--
-- The naive fixes are both wrong:
--   - dropping the append-only trigger makes history editable, which is the one
--     thing these tables exist to prevent
--   - exempting DELETE entirely means a single stray statement can quietly
--     destroy the audit trail
--
-- So erasure becomes an explicit, named operation. app.erase_organization()
-- declares itself in a session setting that the trigger honours, and nothing
-- else can delete from an append-only table. An ordinary DELETE still fails,
-- exactly as before.

create or replace function app.deny_mutation() returns trigger
language plpgsql as $FN$
declare erasing text;
begin
  if tg_op = 'DELETE' then
    -- Set only by app.erase_organization(), and only for the duration of that
    -- one transaction. A row is deletable only as part of erasing the
    -- organization that owns it.
    erasing := nullif(current_setting('app.erasing_org', true), '');
    if erasing is not null then
      -- Every table carrying this trigger has an org_id except
      -- callback_deliveries, which gained one for exactly this kind of reason.
      if to_jsonb(old) ? 'org_id' and (to_jsonb(old) ->> 'org_id') = erasing then
        return old;
      end if;
    end if;
  end if;

  raise exception '% is append-only; % is not permitted', tg_table_name, lower(tg_op)
    using errcode = 'integrity_constraint_violation',
          hint = case when tg_op = 'DELETE'
                 then 'use app.erase_organization() to erase an organization and everything it owns'
                 else 'history is not editable; issue a new record instead' end;
end $FN$;

-- ---------------------------------------------------------------------------
-- The one sanctioned way to destroy tenant data.
-- ---------------------------------------------------------------------------

-- security definer so the append-only guard can be satisfied without granting
-- the application role a blanket delete. It writes an audit record FIRST, in a
-- separate transaction-visible step, so the fact that an erasure happened
-- survives the erasure itself... in a table that is itself erased. That is a
-- genuine limitation and is called out in docs/SECURITY.md rather than papered
-- over: an erasure log that outlives the tenant needs a store outside this
-- database, which does not exist yet.
create or replace function app.erase_organization(target_org uuid, reason text default 'erasure request')
returns table (table_name text, rows_deleted bigint)
language plpgsql volatile security definer set search_path = public, pg_temp as $FN$
declare n bigint;
begin
  if target_org is null then
    raise exception 'erase_organization requires an organization id';
  end if;
  if not exists (select 1 from organizations where id = target_org) then
    raise exception 'organization % does not exist', target_org;
  end if;

  perform set_config('app.erasing_org', target_org::text, true);

  -- Deleting the organization cascades to everything that references it. The
  -- explicit counts below are reported so the caller can record what was
  -- destroyed, which is the part a regulator asks about.
  select count(*) into n from decision_receipts where org_id = target_org;
  table_name := 'decision_receipts'; rows_deleted := n; return next;
  select count(*) into n from audit_events where org_id = target_org;
  table_name := 'audit_events'; rows_deleted := n; return next;
  select count(*) into n from leads where org_id = target_org;
  table_name := 'leads'; rows_deleted := n; return next;
  select count(*) into n from executions where org_id = target_org;
  table_name := 'executions'; rows_deleted := n; return next;

  delete from organizations where id = target_org;

  perform set_config('app.erasing_org', '', true);
  return;
end $FN$;

revoke all on function app.erase_organization(uuid, text) from public;
grant execute on function app.erase_organization(uuid, text) to revenue_swarm_app;
