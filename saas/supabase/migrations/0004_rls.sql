-- 0004_rls.sql
-- Row level security. This file is the database half of the trust boundary.
--
-- Two rules it exists to make unbreakable:
--   1. A policy that only filters reads is incomplete. Every tenant-owned table
--      gets USING (which rows are visible/updatable) *and* WITH CHECK (which
--      rows may be written), so a row cannot be created in, or moved into,
--      another organization.
--   2. Missing context exposes nothing. app.has_org_access() returns false when
--      neither an org GUC nor a member user is present, so a connection with no
--      context reads zero tenant rows rather than all of them.
--
-- FORCE ROW LEVEL SECURITY is set as well as ENABLE, so the policies still
-- apply if the application is ever misconfigured to connect as the table owner.

-- ---------------------------------------------------------------------------
-- users: not tenant-owned. Visible to yourself and to people you share an
-- organization with, so a member list can render without leaking the directory.
-- ---------------------------------------------------------------------------

alter table users enable row level security;
alter table users force row level security;

create policy users_self_or_comember_read on users
  for select using (
    id = app.current_user_id()
    or exists (
      select 1
        from memberships mine
        join memberships theirs on theirs.org_id = mine.org_id
       where mine.user_id = app.current_user_id()
         and theirs.user_id = users.id
    )
  );

create policy users_self_update on users
  for update using (id = app.current_user_id())
          with check (id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

alter table organizations enable row level security;
alter table organizations force row level security;

create policy organizations_read on organizations
  for select using (app.has_org_access(id));

-- Changing an organization's automation ceiling is a policy change, so it is
-- restricted to human admins. An API key can never raise it.
create policy organizations_admin_update on organizations
  for update using (app.has_org_admin(id))
          with check (app.has_org_admin(id));

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

alter table memberships enable row level security;
alter table memberships force row level security;

create policy memberships_read on memberships
  for select using (app.has_org_access(org_id));

create policy memberships_admin_insert on memberships
  for insert with check (app.has_org_admin(org_id));

create policy memberships_admin_update on memberships
  for update using (app.has_org_admin(org_id))
          with check (app.has_org_admin(org_id));

create policy memberships_admin_delete on memberships
  for delete using (app.has_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- api_keys
--
-- Human admins only: a machine principal must not be able to enumerate its
-- siblings. Note also the column grant in 0005 — the application role has no
-- SELECT privilege on secret_hash at all, so even a SQL injection inside a
-- correctly scoped session cannot read a key hash.
-- ---------------------------------------------------------------------------

alter table api_keys enable row level security;
alter table api_keys force row level security;

create policy api_keys_admin_read on api_keys
  for select using (app.has_org_admin(org_id));

create policy api_keys_admin_insert on api_keys
  for insert with check (app.has_org_admin(org_id));

-- Revocation is an update, not a delete: a revoked key must stay auditable.
create policy api_keys_admin_update on api_keys
  for update using (app.has_org_admin(org_id))
          with check (app.has_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- Tenant-owned pipeline tables
-- ---------------------------------------------------------------------------

alter table rubric_versions enable row level security;
alter table rubric_versions force row level security;

create policy rubric_versions_read on rubric_versions
  for select using (app.has_org_access(org_id));

-- Authoring and publishing a rubric is a human privileged action. This is what
-- stops an LLM-driven code path from promoting its own scoring changes.
create policy rubric_versions_admin_insert on rubric_versions
  for insert with check (app.has_org_admin(org_id));

create policy rubric_versions_admin_update on rubric_versions
  for update using (app.has_org_admin(org_id))
          with check (app.has_org_admin(org_id));

alter table leads enable row level security;
alter table leads force row level security;

create policy leads_read on leads
  for select using (app.has_org_access(org_id));

create policy leads_insert on leads
  for insert with check (app.has_org_access(org_id));

create policy leads_update on leads
  for update using (app.has_org_access(org_id))
          with check (app.has_org_access(org_id));

-- Erasure is a real requirement (a data subject request), so delete exists —
-- but only for human admins, and only within their own organization.
create policy leads_admin_delete on leads
  for delete using (app.has_org_admin(org_id));

alter table executions enable row level security;
alter table executions force row level security;

create policy executions_read on executions
  for select using (app.has_org_access(org_id));

create policy executions_insert on executions
  for insert with check (app.has_org_access(org_id));

create policy executions_update on executions
  for update using (app.has_org_access(org_id))
          with check (app.has_org_access(org_id));

alter table lead_evidence enable row level security;
alter table lead_evidence force row level security;

create policy lead_evidence_read on lead_evidence
  for select using (app.has_org_access(org_id));

create policy lead_evidence_insert on lead_evidence
  for insert with check (app.has_org_access(org_id));

alter table decision_receipts enable row level security;
alter table decision_receipts force row level security;

create policy decision_receipts_read on decision_receipts
  for select using (app.has_org_access(org_id));

create policy decision_receipts_insert on decision_receipts
  for insert with check (app.has_org_access(org_id));
-- No update or delete policy: the append-only trigger refuses them, and with no
-- policy the attempt does not even reach the trigger.

alter table callback_deliveries enable row level security;
alter table callback_deliveries force row level security;

create policy callback_deliveries_read on callback_deliveries
  for select using (app.has_org_access(org_id));

create policy callback_deliveries_insert on callback_deliveries
  for insert with check (app.has_org_access(org_id));

alter table approval_requests enable row level security;
alter table approval_requests force row level security;

create policy approval_requests_read on approval_requests
  for select using (app.has_org_access(org_id));

create policy approval_requests_insert on approval_requests
  for insert with check (app.has_org_access(org_id));

-- Deciding an approval requires a human member. A machine principal has no
-- current_user_id, so app.org_role() is null and this policy denies it: an API
-- key cannot approve the action it asked for.
create policy approval_requests_member_update on approval_requests
  for update using (
        app.has_org_access(org_id)
        and app.org_role(org_id) in ('owner', 'admin', 'member')
      )
      with check (
        app.has_org_access(org_id)
        and app.org_role(org_id) in ('owner', 'admin', 'member')
      );

alter table lead_outcomes enable row level security;
alter table lead_outcomes force row level security;

create policy lead_outcomes_read on lead_outcomes
  for select using (app.has_org_access(org_id));

create policy lead_outcomes_insert on lead_outcomes
  for insert with check (app.has_org_access(org_id));

alter table evaluation_runs enable row level security;
alter table evaluation_runs force row level security;

create policy evaluation_runs_read on evaluation_runs
  for select using (app.has_org_access(org_id));

create policy evaluation_runs_insert on evaluation_runs
  for insert with check (app.has_org_access(org_id));

alter table integrations enable row level security;
alter table integrations force row level security;

create policy integrations_read on integrations
  for select using (app.has_org_access(org_id));

create policy integrations_admin_insert on integrations
  for insert with check (app.has_org_admin(org_id));

create policy integrations_admin_update on integrations
  for update using (app.has_org_admin(org_id))
          with check (app.has_org_admin(org_id));

alter table audit_events enable row level security;
alter table audit_events force row level security;

create policy audit_events_read on audit_events
  for select using (app.has_org_access(org_id));

create policy audit_events_insert on audit_events
  for insert with check (app.has_org_access(org_id));
