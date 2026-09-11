/**
 * POST /v1/leads  — accept a lead, return 202 and a trace id
 * GET  /v1/leads  — list leads in the authenticated organization
 *
 * The asynchronous shape is the contract, not an optimisation. Qualification
 * involves a model call and possibly enrichment; holding an HTTP connection
 * open for it would make the endpoint's latency the provider's latency.
 */
import { NextResponse } from 'next/server';
import { authenticate, requireScope } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { ingestLead } from '@/lib/leads/ingest';
import { callbackUrlFor, dispatchExecution } from '@/lib/n8n/dispatch';
import { fail, internal, invalid, ok } from '@/lib/http';
import { consumeIngestBudget, retryAfterSeconds } from '@/lib/rate-limit';
import { LeadIngest, LeadListQuery, DispatchPayload } from '@/lib/schemas';

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const scopeError = requireScope(auth.principal, 'leads:write');
  if (scopeError) return fail(scopeError.status, scopeError.error, scopeError.detail);

  // Throttle before parsing, so a flood of malformed bodies costs the same as a
  // flood of valid ones. This is the endpoint worth protecting: each accepted
  // request buys a model call.
  const budget = await consumeIngestBudget(auth.principal);
  if (!budget.allowed) {
    const retryAfter = retryAfterSeconds(budget);
    return NextResponse.json(
      {
        error: 'rate_limited',
        detail: `${budget.limit} requests per window exceeded`,
        limit: budget.limit,
        reset_at: budget.resetAt.toISOString(),
      },
      {
        status: 429,
        headers: {
          'retry-after': String(retryAfter),
          'x-ratelimit-limit': String(budget.limit),
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(budget.resetAt.getTime() / 1000)),
        },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid('body must be JSON');
  }

  const parsed = LeadIngest.safeParse(raw);
  if (!parsed.success) {
    // Strict schema: a request carrying org_id / tenant_id lands here rather
    // than being quietly accepted with the field ignored.
    return invalid('the lead payload is not valid', parsed.error.issues);
  }

  try {
    const result = await withOrgContext(auth.principal, (tx) =>
      ingestLead(tx, auth.principal, parsed.data),
    );

    if (result.replayed) {
      // The original execution stands. Returning its trace id means a client
      // that retried on a timeout converges on one run, not two.
      return ok(
        {
          status: 'duplicate',
          lead_id: result.leadPublicId,
          trace_id: result.traceId,
          dry_run: result.dryRun,
        },
        200,
      );
    }

    const lead = await withOrgContext(auth.principal, (tx) =>
      tx.one<Record<string, string | null>>(
        `select public_id, email, first_name, last_name, company_name, job_title, phone, website, notes, source
           from leads where id = $1`,
        [result.leadId],
      ),
    );

    const payload = DispatchPayload.parse({
      trace_id: result.traceId,
      execution_id: result.executionId,
      organization_id: auth.principal.orgId,
      lead: {
        id: result.leadId,
        public_id: lead?.public_id ?? result.leadPublicId,
        email: lead?.email ?? parsed.data.email,
        first_name: lead?.first_name ?? undefined,
        last_name: lead?.last_name ?? undefined,
        company_name: lead?.company_name ?? undefined,
        job_title: lead?.job_title ?? undefined,
        phone: lead?.phone ?? undefined,
        website: lead?.website ?? undefined,
        notes: lead?.notes ?? undefined,
        source: lead?.source ?? parsed.data.source,
      },
      rubric_version: result.rubricVersion,
      rubric_version_id: result.rubricVersionId,
      dry_run: result.dryRun,
      allowed_actions: result.allowed,
      callback_url: callbackUrlFor(result.traceId),
    });

    const dispatched = await dispatchExecution(payload);

    await withOrgContext(auth.principal, (tx) =>
      tx.query(
        dispatched.ok
          ? `update executions set status = 'dispatched', dispatched_at = now(), engine_execution_id = coalesce($2, engine_execution_id) where id = $1`
          : `update executions set status = 'failed', error = jsonb_build_object('stage','dispatch','reason',$2::text) where id = $1`,
        [result.executionId, dispatched.ok ? dispatched.engineExecutionId : dispatched.detail],
      ),
    );

    if (!dispatched.ok) {
      // The lead is durably stored and the failure is recorded against the
      // execution, so this is a retryable engine problem rather than lost work.
      return fail(503, 'engine_unavailable', 'the lead was stored but could not be dispatched', {
        lead_id: result.leadPublicId,
        trace_id: result.traceId,
        reason: dispatched.reason,
      });
    }

    return ok(
      {
        status: 'accepted',
        lead_id: result.leadPublicId,
        trace_id: result.traceId,
        dry_run: result.dryRun,
        allowed_actions: result.allowed,
      },
      202,
    );
  } catch (err) {
    return internal(err, 'POST /v1/leads');
  }
}

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const scopeError = requireScope(auth.principal, 'leads:read');
  if (scopeError) return fail(scopeError.status, scopeError.error, scopeError.detail);

  const url = new URL(req.url);
  const parsed = LeadListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return invalid('invalid query', parsed.error.issues);
  const { tier, status, q, limit, cursor } = parsed.data;

  try {
    const rows = await withOrgContext(auth.principal, (tx) =>
      tx.query<Record<string, unknown>>(
        `select l.public_id, l.email, l.company_name, l.job_title, l.status, l.source,
                l.latest_score, l.latest_tier, l.created_at, l.updated_at,
                e.trace_id as latest_trace_id, e.status as latest_execution_status
           from leads l
           left join executions e on e.id = l.latest_execution_id
          where l.archived_at is null
            and ($1::lead_tier is null or l.latest_tier = $1::lead_tier)
            and ($2::lead_status is null or l.status = $2::lead_status)
            and ($3::text is null or l.email ilike '%' || $3 || '%' or l.company_name ilike '%' || $3 || '%')
            and ($4::timestamptz is null or l.created_at < $4::timestamptz)
          order by l.created_at desc
          limit $5`,
        [tier ?? null, status ?? null, q ?? null, cursor ?? null, limit],
      ),
    );
    const last = rows.at(-1) as { created_at?: string } | undefined;
    return ok({
      data: rows,
      // Keyset pagination: an offset would drift as new leads arrive.
      next_cursor: rows.length === limit && last?.created_at ? last.created_at : null,
    });
  } catch (err) {
    return internal(err, 'GET /v1/leads');
  }
}
