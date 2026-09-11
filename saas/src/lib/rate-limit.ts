/**
 * Request throttling.
 *
 * Applied to lead ingestion specifically, because that is the endpoint where a
 * single accepted request costs a model call. A read endpoint that returns rows
 * this organization already owns is not the expensive one.
 *
 * Two subjects are checked, not one:
 *
 *   key:<id>  a single credential cannot exhaust the organization's budget
 *   org:<id>  the organization has a ceiling regardless of how many keys it
 *             issues, so minting more keys is not a way around the limit
 *
 * The counter lives in Postgres via a security-definer function that consumes
 * and reports in one statement. See 0006_rate_limit.sql for why not Redis.
 */
import { withResolver, type Principal } from './db/client';

export interface RateLimitDecision {
  allowed: boolean;
  used: number;
  limit: number;
  resetAt: Date;
  /** Which subject ran out, for the log and the Retry-After header. */
  subject: string;
}

export interface RateLimitConfig {
  perKey: number;
  perOrg: number;
  windowSeconds: number;
}

export function rateLimitConfigFromEnv(): RateLimitConfig {
  return {
    perKey: Number(process.env.RATE_LIMIT_INGEST_PER_KEY ?? 60),
    perOrg: Number(process.env.RATE_LIMIT_INGEST_PER_ORG ?? 300),
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
  };
}

function subjectsFor(principal: Principal): { subject: string; limit: number }[] {
  const config = rateLimitConfigFromEnv();
  const subjects: { subject: string; limit: number }[] = [
    { subject: `org:${principal.orgId}`, limit: config.perOrg },
  ];
  if (principal.kind === 'api_key') {
    // Checked first so the narrower limit produces the error.
    subjects.unshift({ subject: `key:${principal.apiKeyId}`, limit: config.perKey });
  }
  return subjects;
}

/**
 * Consume one unit against every applicable subject.
 *
 * Note that a request which trips the second subject has already consumed a
 * unit from the first. That is the correct behaviour for a throttle — the work
 * of asking was still done — and it is why the limits are deliberately not
 * equal: the per-key limit is the one a caller normally meets.
 */
export async function consumeIngestBudget(principal: Principal): Promise<RateLimitDecision> {
  const config = rateLimitConfigFromEnv();
  const subjects = subjectsFor(principal);

  return withResolver(async (tx) => {
    let last: RateLimitDecision | undefined;
    for (const { subject, limit } of subjects) {
      const row = await tx.one<{
        allowed: boolean;
        used: number;
        limit_value: number;
        reset_at: Date;
      }>('select allowed, used, limit_value, reset_at from app.consume_rate_limit($1, $2, $3)', [
        subject,
        limit,
        config.windowSeconds,
      ]);
      if (!row) throw new Error('rate limit function returned no row');
      last = {
        allowed: row.allowed,
        used: row.used,
        limit: row.limit_value,
        resetAt: new Date(row.reset_at),
        subject,
      };
      if (!row.allowed) return last;
    }
    return last!;
  });
}

export function retryAfterSeconds(decision: RateLimitDecision, now = Date.now()): number {
  return Math.max(1, Math.ceil((decision.resetAt.getTime() - now) / 1000));
}
