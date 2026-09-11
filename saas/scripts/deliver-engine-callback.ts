/**
 * Deliver a completion callback that the engine built but could not send.
 *
 *   npx tsx scripts/deliver-engine-callback.ts <n8n-execution-id>
 *
 * Why this exists, stated plainly so the evidence it produces is not
 * mistaken for something it is not:
 *
 * n8n Cloud refuses to make HTTP requests to 127.0.0.1 — its own SSRF
 * protection, working correctly. So when the control plane runs on a laptop,
 * the engine builds and signs a perfectly good completion and then cannot
 * deliver it. This reads the *actual body the engine produced* out of that
 * execution's stored node output, and re-signs it with the same per-execution
 * key and a fresh timestamp and nonce — which is exactly what the engine itself
 * does on a retry.
 *
 * What this does NOT do: invent a payload. If the engine did not run, or did
 * not reach Build Callback, there is nothing here to deliver and the script
 * fails rather than fabricating one.
 *
 * This is a bridge for a missing public URL, not a permanent component. Once
 * the control plane is reachable, the engine delivers its own callbacks and
 * this script has no purpose.
 */
import { Client } from 'pg';
import { callbackTokenFor, signRequest } from '../src/lib/hmac';

const executionId = process.argv[2];
const base = process.env.N8N_BASE_URL;
const apiKey = process.env.N8N_API_KEY;
const appUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';
const master = process.env.N8N_CALLBACK_SECRET;
const adminDb = process.env.ADMIN_DATABASE_URL;

if (!executionId || !base || !apiKey || !master || !adminDb) {
  console.error(
    'usage: tsx scripts/deliver-engine-callback.ts <n8n-execution-id>\n' +
      'needs N8N_BASE_URL, N8N_API_KEY, N8N_CALLBACK_SECRET, ADMIN_DATABASE_URL',
  );
  process.exit(1);
}

interface NodeRun {
  data?: { main?: { json?: Record<string, unknown> }[][] };
}

async function main() {
  const res = await fetch(`${base}/api/v1/executions/${executionId}?includeData=true`, {
    headers: { 'X-N8N-API-KEY': apiKey! },
  });
  if (!res.ok) {
    console.error(`n8n returned ${res.status} for execution ${executionId}`);
    process.exit(1);
  }
  const execution = (await res.json()) as {
    workflowId: string;
    status: string;
    data?: { resultData?: { runData?: Record<string, NodeRun[]> } };
  };

  const runs = execution.data?.resultData?.runData?.['Build Callback'];
  const built = runs?.[0]?.data?.main?.[0]?.[0]?.json;
  if (!built || built['callback_skipped'] !== false) {
    console.error(
      `execution ${executionId} has no Build Callback output to deliver — ` +
        `it either did not reach that node or was not dispatched by the control plane.`,
    );
    process.exit(1);
  }

  const body = String(built['callback_body']);
  const traceId = String(built['trace_id']);
  const originalSignature = String(built['signature']);

  // The control plane, not the engine, is the authority on which execution this
  // trace belongs to — same rule the callback handler follows.
  const db = new Client({ connectionString: adminDb, ssl: undefined });
  await db.connect();
  const row = (
    await db.query<{ id: string; status: string }>(
      'select id, status::text as status from executions where trace_id = $1',
      [traceId],
    )
  ).rows[0];
  await db.end();

  if (!row) {
    console.error(`no execution in the control plane with trace ${traceId}`);
    process.exit(1);
  }

  const path = `/api/internal/executions/${traceId}/complete`;
  const token = callbackTokenFor(master!, row.id);
  const signed = signRequest({ secret: token, method: 'POST', path, body });

  console.log(`\n  engine execution   ${executionId} (${execution.status})`);
  console.log(`  trace              ${traceId}`);
  console.log(`  control plane exec ${row.id} (${row.status})`);
  console.log(`  body               ${body.length} bytes, produced by the engine`);
  console.log(`  engine signature   ${originalSignature.slice(0, 24)}…  (stale timestamp)`);
  console.log(`  re-signed          ${signed['x-swarm-signature'].slice(0, 24)}…\n`);

  const delivered = await fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed },
    body,
  });
  const text = await delivered.text();
  console.log(`  POST ${path} -> ${delivered.status}`);
  console.log(`  ${text}\n`);
  process.exit(delivered.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
