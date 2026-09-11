-- 0005_grants.sql
-- Privileges for the application role, and the two security-definer entry
-- points that exist because authentication has to happen *before* there is any
-- organization context to authorize against.

grant usage on schema public to revenue_swarm_app;
grant usage on schema app to revenue_swarm_app;

grant select, insert, update on
  organizations, memberships, leads, executions, lead_evidence,
  decision_receipts, callback_deliveries, approval_requests, lead_outcomes,
  evaluation_runs, integrations, rubric_versions, audit_events, users
  to revenue_swarm_app;

grant delete on leads, memberships to revenue_swarm_app;

grant usage, select on all sequences in schema public to revenue_swarm_app;

-- api_keys: column-level privileges, deliberately omitting secret_hash. The
-- application role has no way to read a key hash even with an arbitrary query,
-- which is a control that survives a SQL injection in application code.
grant select (
  id, org_id, name, prefix, scopes, created_by,
  created_at, updated_at, last_used_at, expires_at, revoked_at
) on api_keys to revenue_swarm_app;

grant insert (
  id, org_id, name, prefix, secret_hash, scopes, created_by, expires_at
) on api_keys to revenue_swarm_app;

grant update (name, scopes, revoked_at, expires_at, updated_at) on api_keys to revenue_swarm_app;

grant execute on function
  app.current_user_id(), app.current_org_id(),
  app.has_org_access(uuid), app.org_role(uuid), app.has_org_admin(uuid)
  to revenue_swarm_app;

-- ---------------------------------------------------------------------------
-- API key authentication
--
-- The bootstrapping problem: to know which organization a request belongs to we
-- must read api_keys, but api_keys is protected by a policy that needs to know
-- the organization. This function is the single, narrow, audited way across
-- that gap.
--
-- It takes a hash, never a secret, so the raw key is not present in the query
-- text, the parameter log, or pg_stat_statements. It returns nothing at all on
-- any failure, so a caller cannot tell "unknown prefix" from "wrong secret"
-- from "revoked".
-- ---------------------------------------------------------------------------

create or replace function app.authenticate_api_key(p_prefix text, p_secret_hash text)
returns table (api_key_id uuid, org_id uuid, scopes text[])
language plpgsql volatile security definer set search_path = public, pg_temp as $FN$
declare found api_keys;
begin
  select * into found from api_keys k where k.prefix = p_prefix;
  if not found.id is not null then
    return;
  end if;
  -- Comparing digests, not secrets. The comparison is over a value the caller
  -- would have to already know to exploit a timing difference.
  if found.secret_hash <> p_secret_hash then
    return;
  end if;
  if found.revoked_at is not null then
    return;
  end if;
  if found.expires_at is not null and found.expires_at <= now() then
    return;
  end if;

  update api_keys set last_used_at = now() where id = found.id;

  return query select found.id, found.org_id, found.scopes;
end $FN$;

revoke all on function app.authenticate_api_key(text, text) from public;
grant execute on function app.authenticate_api_key(text, text) to revenue_swarm_app;

-- ---------------------------------------------------------------------------
-- Callback target resolution
--
-- A completion callback carries a trace id and a signature. It does NOT carry
-- an organization, and if it did we would ignore it: the owning organization is
-- whatever we recorded when we dispatched the job. This function is how the
-- callback handler learns that, before opening a session scoped to it.
-- ---------------------------------------------------------------------------

create or replace function app.resolve_callback_target(p_trace_id text)
returns table (
  execution_id uuid,
  org_id uuid,
  lead_id uuid,
  status execution_status,
  completed_at timestamptz,
  dry_run boolean
)
language sql stable security definer set search_path = public, pg_temp as $FN$
  select e.id, e.org_id, e.lead_id, e.status, e.completed_at, e.dry_run
    from executions e
   where e.trace_id = p_trace_id
$FN$;

revoke all on function app.resolve_callback_target(text) from public;
grant execute on function app.resolve_callback_target(text) to revenue_swarm_app;

-- ---------------------------------------------------------------------------
-- Organization resolution for a human session
--
-- Same shape of problem: a signed-in user needs their organization list before
-- any org context exists. Restricted to the caller's own memberships.
-- ---------------------------------------------------------------------------

create or replace function app.my_organizations()
returns table (org_id uuid, slug text, name text, role org_role, automation_level text)
language sql stable security definer set search_path = public, pg_temp as $FN$
  select o.id, o.slug, o.name, m.role, o.automation_level
    from memberships m
    join organizations o on o.id = m.org_id
   where m.user_id = app.current_user_id()
     and o.deleted_at is null
   order by o.name
$FN$;

revoke all on function app.my_organizations() from public;
grant execute on function app.my_organizations() to revenue_swarm_app;
