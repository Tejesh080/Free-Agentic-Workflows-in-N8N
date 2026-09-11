/**
 * Canonical request signing for the two internal hops:
 *
 *   SaaS API  --dispatch-->  n8n
 *   n8n       --callback-->  SaaS API
 *
 * Each direction has its own secret, so a leak of one does not grant the other.
 *
 * What is signed:
 *
 *   v1:{METHOD}:{path}:{timestamp}:{nonce}:{sha256hex(raw body bytes)}
 *
 * Every component is there for a reason:
 *   - method and path      bind a signature to one endpoint, so a signature
 *                          captured from a completion cannot be replayed
 *                          against a different route
 *   - timestamp            bounds how long a captured request stays usable
 *   - nonce                makes a request single-use once recorded
 *   - digest of raw bytes  binds the signature to the exact payload, including
 *                          key order and whitespace, so re-serialising cannot
 *                          change the meaning of a signed body
 *
 * The body digest is taken over the raw bytes as received, never over a parsed
 * and re-serialised object: that is the classic way a signature check passes
 * while the handler acts on different data.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The key the engine signs a completion with.
 *
 * Not the master secret. The master never leaves this process; what the engine
 * receives in its dispatch payload is HMAC(master, execution_id) — a token that
 * is different for every execution and derived, so nothing extra is stored.
 *
 * Why per-execution rather than one shared callback secret:
 *   - n8n persists execution data, so a shared secret would sit in every
 *     execution log forever. This puts one execution's token in one log.
 *   - A token is useless outside its own execution: the signature also binds
 *     the path, which carries the trace id.
 *   - Rotating the master invalidates every outstanding token at once.
 *
 * It is also the reason the callback handler resolves the execution *before*
 * verifying: it cannot know which key to expect until it does. Both "unknown
 * trace" and "bad signature" return the same 401, so resolving first does not
 * turn the endpoint into an oracle for which traces exist.
 */
export function callbackTokenFor(masterSecret: string, executionId: string): string {
  return createHmac('sha256', masterSecret).update(`callback:v1:${executionId}`).digest('base64url');
}

export const SIGNATURE_HEADER = 'x-swarm-signature';
export const TIMESTAMP_HEADER = 'x-swarm-timestamp';
export const NONCE_HEADER = 'x-swarm-nonce';

/** How stale a signed request may be. Five minutes covers clock skew and retries. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function bodyDigest(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function canonicalString(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  digest: string;
}): string {
  return [
    'v1',
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.digest,
  ].join(':');
}

/** Intersected with Record<string, string> so the result spreads into a fetch init. */
export type SignedHeaders = {
  [SIGNATURE_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [NONCE_HEADER]: string;
} & Record<string, string>;

export function signRequest(opts: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp?: number;
  nonce?: string;
}): SignedHeaders {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url');
  const digest = bodyDigest(opts.body);
  const mac = createHmac('sha256', opts.secret)
    .update(canonicalString({ method: opts.method, path: opts.path, timestamp, nonce, digest }))
    .digest('hex');
  return {
    [SIGNATURE_HEADER]: `v1=${mac}`,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  };
}

export type VerifyFailure =
  | 'missing_headers'
  | 'unsupported_scheme'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'no_secret';

export type VerifyResult =
  | { ok: true; nonce: string; signedAt: Date; digest: string }
  | { ok: false; reason: VerifyFailure };

export function verifyRequest(opts: {
  secret: string | undefined;
  method: string;
  path: string;
  body: string;
  headers: { get(name: string): string | null };
  toleranceSeconds?: number;
  now?: number;
}): VerifyResult {
  // Fail closed. A deployment with no callback secret configured accepts
  // nothing, rather than accepting everything.
  if (!opts.secret) return { ok: false, reason: 'no_secret' };

  const signature = opts.headers.get(SIGNATURE_HEADER);
  const timestamp = opts.headers.get(TIMESTAMP_HEADER);
  const nonce = opts.headers.get(NONCE_HEADER);
  if (!signature || !timestamp || !nonce) return { ok: false, reason: 'missing_headers' };

  if (!signature.startsWith('v1=')) return { ok: false, reason: 'unsupported_scheme' };
  const presented = signature.slice(3);

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'stale_timestamp' };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Both directions: a far-future timestamp is as suspect as an old one.
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const digest = bodyDigest(opts.body);
  const expected = createHmac('sha256', opts.secret)
    .update(
      canonicalString({ method: opts.method, path: opts.path, timestamp, nonce, digest }),
    )
    .digest('hex');

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, nonce, signedAt: new Date(ts * 1000), digest };
}
