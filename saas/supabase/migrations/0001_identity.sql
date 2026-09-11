-- 0001_identity.sql
-- Revenue Swarm: organizations, membership, machine credentials, and the
-- authorization primitives every later policy is written against.
--
-- Design rule enforced here: organization identity is NEVER read from a request
-- body. It arrives in the database session as a GUC that only the API server
-- sets, after the server has resolved an authenticated principal.

create schema if not exists app;
comment on schema app is 'Authorization primitives. Referenced by every RLS policy; never written to by application code.';

-- The role the API server connects as. It is deliberately NOT the table owner,
-- so row level security applies to it without relying on FORCE alone.
do $ROLE$
begin
  if not exists (select 1 from pg_roles where rolname = 'revenue_swarm_app') then
    create role revenue_swarm_app nologin noinherit;
  end if;
end $ROLE$;

-- ---------------------------------------------------------------------------
-- Session principal
-- ---------------------------------------------------------------------------

-- The authenticated human, when there is one.
--   app.user_id            -> set by our own API server (set_config local)
--   request.jwt.claim.sub  -> set by Supabase/PostgREST from a verified JWT
-- Both are session state. Neither can be reached from a request body.
create or replace function app.current_user_id() returns uuid
language plpgsql stable as $FN$
declare raw text;
begin
  raw := nullif(current_setting('app.user_id', true), '');
  if raw is null then
    raw := nullif(current_setting('request.jwt.claim.sub', true), '');
  end if;
  if raw is null then
    return null;
  end if;
  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end $FN$;

-- The organization the server resolved for this request. For an API key this is
-- the key's owning organization; for a human it is the organization they are
-- currently acting in. Absent context must expose nothing.
create or replace function app.current_org_id() returns uuid
language plpgsql stable as $FN$
declare raw text;
begin
  raw := nullif(current_setting('app.org_id', true), '');
  if raw is null then
    return null;
  end if;
  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end $FN$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Mirrors the identity provider's user record. Kept local so memberships can
-- carry a real foreign key and so a display name does not require an auth call.
create table users (
  id            uuid primary key,
  email         text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index users_email_lower_key on users (lower(email));

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null,
  name        text not null,
  -- Automation ceiling for the whole organization. Governs what an execution is
  -- permitted to do without a human, independent of what a caller asks for.
  automation_level text not null default 'dry_run'
                   check (automation_level in ('dry_run', 'crm_write', 'outreach_draft', 'outreach_send')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index organizations_slug_key on organizations (lower(slug));

create type org_role as enum ('owner', 'admin', 'member', 'viewer');

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        org_role not null default 'member',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

-- ---------------------------------------------------------------------------
-- Authorization predicates
-- ---------------------------------------------------------------------------

-- One predicate, used by every policy, so there is a single place where the
-- meaning of "may act on this organization" is defined.
--
-- security definer because it reads memberships, which is itself protected by
-- RLS; without it the membership lookup inside a policy would recurse.
create or replace function app.has_org_access(target_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $FN$
  select target_org is not null
     and (
       -- Machine principal: server-resolved organization for this request.
       target_org = app.current_org_id()
       -- Human principal: proven membership.
       or exists (
         select 1 from memberships m
          where m.org_id = target_org
            and m.user_id = app.current_user_id()
       )
     )
$FN$;

create or replace function app.org_role(target_org uuid) returns org_role
language sql stable security definer set search_path = public, pg_temp as $FN$
  select m.role from memberships m
   where m.org_id = target_org
     and m.user_id = app.current_user_id()
$FN$;

-- Privileged human action (rubric publication, key revocation, integrations).
-- A machine principal is never privileged: an API key cannot change policy.
create or replace function app.has_org_admin(target_org uuid) returns boolean
language sql stable as $FN$
  select app.org_role(target_org) in ('owner', 'admin')
$FN$;

-- ---------------------------------------------------------------------------
-- Machine credentials
-- ---------------------------------------------------------------------------

-- Only the hash is stored. `prefix` is the non-secret lookup handle that lets a
-- presented key find its row in one indexed read instead of a scan over every
-- hash, and lets a leaked key be named in a log without recording the secret.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  name          text not null,
  prefix        text not null,
  secret_hash   text not null,
  scopes        text[] not null default array['leads:write', 'leads:read'],
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);
create unique index api_keys_prefix_key on api_keys (prefix);
create index api_keys_org_idx on api_keys (org_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $FN$
begin
  new.updated_at := now();
  return new;
end $FN$;

create trigger users_touch         before update on users         for each row execute function app.touch_updated_at();
create trigger organizations_touch before update on organizations for each row execute function app.touch_updated_at();
create trigger memberships_touch   before update on memberships   for each row execute function app.touch_updated_at();
create trigger api_keys_touch      before update on api_keys      for each row execute function app.touch_updated_at();
