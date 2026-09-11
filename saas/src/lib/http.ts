/**
 * Response shapes and the error vocabulary.
 *
 * `notFound()` is used for two different situations on purpose: an object that
 * does not exist, and an object that exists in another organization. They must
 * be indistinguishable, or the API becomes an oracle for "does org B have a
 * lead with this id".
 */
import { NextResponse } from 'next/server';

export type ApiError =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'replayed'
  | 'rate_limited'
  | 'engine_unavailable'
  | 'internal';

export function ok<T extends object>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function fail(status: number, error: ApiError, detail: string, extra: object = {}): NextResponse {
  return NextResponse.json({ error, detail, ...extra }, { status });
}

export const notFound = () => fail(404, 'not_found', 'no such object');

export function invalid(detail: string, issues?: unknown): NextResponse {
  return fail(400, 'invalid_request', detail, issues ? { issues } : {});
}

/**
 * A last-resort handler. It deliberately does not echo the underlying message:
 * a database error text can contain column names, policy names and fragments of
 * other rows. The detail goes to the server log, the client gets a trace handle.
 */
export function internal(err: unknown, context: string): NextResponse {
  const id = Math.random().toString(36).slice(2, 10);
  console.error(`[${id}] ${context}:`, err);
  return fail(500, 'internal', `unexpected error (reference ${id})`);
}

/** An RLS refusal reaching this layer is a bug in our authorization, not a client error we should explain. */
export function isRlsViolation(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  return /row-level security|permission denied/i.test(msg);
}
