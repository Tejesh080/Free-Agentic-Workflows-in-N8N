/**
 * Dispatching work to the execution engine.
 *
 * The engine is an implementation detail behind this module. Nothing above it
 * knows an n8n webhook exists, and the public API never returns an n8n
 * execution id or URL.
 *
 * Two independent credentials guard the hop, because they fail differently:
 *   - `SWARM_INGEST_KEY` is the shared ingress secret the n8n webhook already
 *     checks, and is what stops an unauthenticated internet caller.
 *   - The HMAC signature binds *this* payload to *this* endpoint at *this*
 *     time, and is what stops a captured request being replayed or edited.
 */
import { DispatchPayload } from '../schemas';
import { signRequest } from '../hmac';

/**
 * The header the n8n webhook's header-auth credential is configured to check.
 * It must match the credential exactly: n8n rejects a mismatch at the edge with
 * 403 before any node runs, which is the behaviour we want but also means a
 * typo here looks like an outage rather than a bug.
 */
export const INGEST_HEADER = 'x-swarm-key';

export type DispatchOutcome =
  | { ok: true; engineExecutionId: string | null }
  | { ok: false; reason: 'not_configured' | 'rejected' | 'unreachable'; detail: string };

export interface DispatchConfig {
  webhookUrl: string | undefined;
  ingestKey: string | undefined;
  signingSecret: string | undefined;
  timeoutMs?: number;
}

export function dispatchConfigFromEnv(): DispatchConfig {
  return {
    webhookUrl: process.env.N8N_INGEST_WEBHOOK_URL,
    ingestKey: process.env.SWARM_INGEST_KEY,
    signingSecret: process.env.N8N_DISPATCH_SECRET,
    timeoutMs: Number(process.env.N8N_DISPATCH_TIMEOUT_MS ?? 10_000),
  };
}

export async function dispatchExecution(
  payload: DispatchPayload,
  config: DispatchConfig = dispatchConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  // Fail closed, and say which piece is missing without printing its value.
  const missing = [
    !config.webhookUrl && 'N8N_INGEST_WEBHOOK_URL',
    !config.ingestKey && 'SWARM_INGEST_KEY',
    !config.signingSecret && 'N8N_DISPATCH_SECRET',
    // Without this the engine would be handed a callback token derived from an
    // empty key, and every completion would then verify against that same empty
    // key — an authentication check that passes for anyone. Refuse to dispatch.
    !process.env.N8N_CALLBACK_SECRET && 'N8N_CALLBACK_SECRET',
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, reason: 'not_configured', detail: `unset: ${missing.join(', ')}` };
  }

  // Validate our own outbound payload. A malformed dispatch is our bug, and it
  // should surface here rather than as an unexplained engine failure.
  const parsed = DispatchPayload.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'rejected', detail: `invalid dispatch payload: ${parsed.error.message}` };
  }

  const body = JSON.stringify(parsed.data);
  const url = new URL(config.webhookUrl!);
  const signed = signRequest({
    secret: config.signingSecret!,
    method: 'POST',
    path: url.pathname,
    body,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INGEST_HEADER]: config.ingestKey!,
        ...signed,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'rejected', detail: `engine returned ${res.status}: ${text.slice(0, 500)}` };
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const id = json['executionId'] ?? json['execution_id'];
    return { ok: true, engineExecutionId: typeof id === 'string' ? id : null };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: (err as Error).name === 'AbortError' ? 'dispatch timed out' : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function callbackUrlFor(traceId: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/internal/executions/${traceId}/complete`;
}
