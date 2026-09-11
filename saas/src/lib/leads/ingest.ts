/**
 * Lead ingestion.
 *
 * The public contract is asynchronous by design: a request that blocks while a
 * model researches a company is a request that times out. The API authenticates,
 * persists, records an execution, dispatches, and returns 202 with a trace id.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Principal, Tx } from '../db/client';
import type { LeadIngest } from '../schemas';

export type AutomationLevel = 'dry_run' | 'crm_write' | 'outreach_draft' | 'outreach_send';
export type AllowedAction = 'crm_write' | 'outreach_draft' | 'outreach_send';

/**
 * What an execution is permitted to attempt, derived from the organization's
 * configured ceiling. A caller asking for `dry_run: false` on a `dry_run`
 * organization gets a dry run: the request narrows the ceiling, never raises it.
 */
export function allowedActions(level: AutomationLevel): AllowedAction[] {
  switch (level) {
    case 'dry_run':
      return [];
    case 'crm_write':
      return ['crm_write'];
    case 'outreach_draft':
      return ['crm_write', 'outreach_draft'];
    case 'outreach_send':
      return ['crm_write', 'outreach_draft', 'outreach_send'];
  }
}

export function effectiveDryRun(requested: boolean, level: AutomationLevel): boolean {
  return requested || level === 'dry_run';
}

/**
 * The lead's natural key within an organization. Derived from the payload by
 * the server: a caller cannot choose it, so a caller cannot aim a write at
 * another organization's dedupe slot or overwrite an unrelated lead.
 */
export function dedupeKey(input: Pick<LeadIngest, 'email'>): string {
  return createHash('sha256').update(input.email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 40);
}

/** Stable, opaque, URL-safe public identifier. */
export function publicId(kind: 'lead' | 'trc'): string {
  return `${kind}_${randomBytes(12).toString('base64url')}`;
}

/** Canonical digest of the meaningful payload, for automatic idempotency. */
export function payloadDigest(input: LeadIngest): string {
  const canonical = JSON.stringify({
    email: input.email.trim().toLowerCase(),
    first_name: input.first_name ?? null,
    last_name: input.last_name ?? null,
    company_name: input.company_name ?? null,
    job_title: input.job_title ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    notes: input.notes ?? null,
    source: input.source,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

export interface IngestResult {
  leadId: string;
  leadPublicId: string;
  executionId: string;
  traceId: string;
  dryRun: boolean;
  allowed: AllowedAction[];
  rubricVersion: string | null;
  rubricVersionId: string | null;
  /** True when this request matched an execution that already existed. */
  replayed: boolean;
}

export async function ingestLead(
  tx: Tx,
  principal: Principal,
  input: LeadIngest,
): Promise<IngestResult> {
  const org = await tx.one<{ automation_level: AutomationLevel }>(
    `select automation_level from organizations where id = $1`,
    [principal.orgId],
  );
  if (!org) {
    // RLS returned nothing for the organization the principal claims to be in.
    // That is a server-side contradiction, not a client error.
    throw new Error('organization not visible in the current context');
  }

  const level = org.automation_level;
  const dryRun = effectiveDryRun(input.dry_run, level);
  const allowed = dryRun ? [] : allowedActions(level);

  const dk = dedupeKey(input);
  const idemKey = input.idempotency_key ?? `auto:${dk}:${payloadDigest(input)}`;

  // The lead is the durable record of a person; repeat contact updates it rather
  // than creating a second row. `org_id` comes from the principal, so the
  // conflict target can only ever be within the caller's own organization.
  const lead = await tx.one<{ id: string; public_id: string }>(
    `insert into leads (
        org_id, public_id, dedupe_key, source, email, first_name, last_name,
        company_name, job_title, phone, website, notes, raw_payload, status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'received')
     on conflict (org_id, dedupe_key) do update set
        first_name   = coalesce(excluded.first_name, leads.first_name),
        last_name    = coalesce(excluded.last_name, leads.last_name),
        company_name = coalesce(excluded.company_name, leads.company_name),
        job_title    = coalesce(excluded.job_title, leads.job_title),
        phone        = coalesce(excluded.phone, leads.phone),
        website      = coalesce(excluded.website, leads.website),
        notes        = coalesce(excluded.notes, leads.notes),
        raw_payload  = excluded.raw_payload,
        updated_at   = now()
     returning id, public_id`,
    [
      principal.orgId,
      publicId('lead'),
      dk,
      input.source,
      input.email.trim().toLowerCase(),
      input.first_name ?? null,
      input.last_name ?? null,
      input.company_name ?? null,
      input.job_title ?? null,
      input.phone ?? null,
      input.website ?? null,
      input.notes ?? null,
      JSON.stringify(input),
    ],
  );
  if (!lead) throw new Error('lead upsert produced no row');

  const rubric = await tx.one<{ id: string; version: string }>(
    `select id, version from rubric_versions
      where org_id = $1 and status = 'published' limit 1`,
    [principal.orgId],
  );

  const traceId = publicId('trc');

  // The unique index on (org_id, idempotency_key) is what makes a duplicate
  // ingest harmless. `do nothing` means a repeat returns no row, and we then
  // read back the original rather than starting a second run.
  const inserted = await tx.one<{ id: string; trace_id: string }>(
    `insert into executions (
        org_id, lead_id, trace_id, idempotency_key, status, dry_run, rubric_version_id
     ) values ($1,$2,$3,$4,'queued',$5,$6)
     on conflict (org_id, idempotency_key) do nothing
     returning id, trace_id`,
    [principal.orgId, lead.id, traceId, idemKey, dryRun, rubric?.id ?? null],
  );

  if (!inserted) {
    const existing = await tx.one<{ id: string; trace_id: string; dry_run: boolean }>(
      `select id, trace_id, dry_run from executions
        where org_id = $1 and idempotency_key = $2`,
      [principal.orgId, idemKey],
    );
    if (!existing) throw new Error('idempotency conflict resolved to no execution');
    return {
      leadId: lead.id,
      leadPublicId: lead.public_id,
      executionId: existing.id,
      traceId: existing.trace_id,
      dryRun: existing.dry_run,
      allowed,
      rubricVersion: rubric?.version ?? null,
      rubricVersionId: rubric?.id ?? null,
      replayed: true,
    };
  }

  await tx.query(
    `update leads set status = 'processing', latest_execution_id = $2 where id = $1`,
    [lead.id, inserted.id],
  );

  await tx.query(
    `insert into audit_events (org_id, actor_type, actor_api_key_id, actor_user_id, action, target_type, target_id, trace_id, after)
     values ($1,$2,$3,$4,'lead.ingested','lead',$5,$6,$7)`,
    [
      principal.orgId,
      principal.kind === 'api_key' ? 'api_key' : principal.kind === 'user' ? 'user' : 'system',
      principal.kind === 'api_key' ? principal.apiKeyId : null,
      principal.kind === 'user' ? principal.userId : null,
      lead.id,
      inserted.trace_id,
      JSON.stringify({ dry_run: dryRun, allowed_actions: allowed, source: input.source }),
    ],
  );

  return {
    leadId: lead.id,
    leadPublicId: lead.public_id,
    executionId: inserted.id,
    traceId: inserted.trace_id,
    dryRun,
    allowed,
    rubricVersion: rubric?.version ?? null,
    rubricVersionId: rubric?.id ?? null,
    replayed: false,
  };
}
