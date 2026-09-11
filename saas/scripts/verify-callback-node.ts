/**
 * Proves that the n8n "Build Callback" Code node and the control plane's
 * verifyRequest() agree, before the node is deployed.
 *
 * The node signs with hand-rolled SHA-256/HMAC because n8n Code nodes cannot
 * rely on require('crypto'); this runs that exact source and checks the result
 * against the verifier that will receive it in production.
 */
import { createHmac } from 'node:crypto';
import { SWARM_HMAC_SNIPPET } from './n8n-hmac-snippet.js';
import { BUILD_CALLBACK_BODY } from './wf14-build-callback.js';
import { verifyRequest, callbackTokenFor } from '../src/lib/hmac';

const MASTER = 'master-secret-for-verification-only';
const EXECUTION_ID = '2f1c8a44-9f1e-4a77-9b33-6d5a1f0c2e91';
const token = callbackTokenFor(MASTER, EXECUTION_ID);

const source = BUILD_CALLBACK_BODY.replace('__HMAC__', SWARM_HMAC_SNIPPET);

const intake = {
  callback_url: 'https://app.example.com/api/internal/executions/trc_abc123/complete',
  callback_token: token,
  trace_id: 'trc_abc123',
};

const response = {
  ok: true,
  outcome: 'processed',
  qualification: {
    score: 90,
    tier: 'HOT',
    scoring: {
      rubric_version: '1.2.0',
      components: [{ component: 'authority', points: 25, detail: 'seniority=executive' }],
      modifiers: [{ modifier: 'unsupported_evidence', points: -10, reason: 'quote absent' }],
    },
    grounding: { unsupported_evidence: [{ signal: 'budget_signal', quote: 'we signed a 500k contract last week' }] },
    signals: { budget_signal: 'explicit', evidence: [{ signal: 'budget_signal', quote: 'we signed a 500k contract last week' }] },
    verification: { verified: true, score: 1 },
    provenance: { model_provider: 'google', prompt_sha: '7b1c4e9' },
  },
  crm: { contact_id: '352173146590', contact_status: 'written', deal_id: '292324390346', deal_status: 'written' },
  outreach: { attempted: false, sent: false, status: 'not_attempted', detail: 'unsupported evidence', governance: {} },
  steps: [
    { step: 'qualify', done: true, detail: 'score 90 (HOT)' },
    { step: 'crm_task', done: false, detail: 'skipped_operation_disabled' },
  ],
};

// Emulate the n8n Code-node surface the body relies on.
const $ = (name: string) => ({ first: () => ({ json: name === 'Normalise Intake' ? intake : response }) });
const $execution = { id: '1052' };

const run = new Function('$', '$execution', source);
const out = run($, $execution) as { json: Record<string, unknown> }[];
const item = out[0]!.json;

if (item['callback_skipped'] !== false) {
  console.error('FAIL  node reported callback_skipped');
  process.exit(1);
}

const body = String(item['callback_body']);
const headers = new Map<string, string>([
  ['x-swarm-signature', String(item['signature'])],
  ['x-swarm-timestamp', String(item['timestamp'])],
  ['x-swarm-nonce', String(item['nonce'])],
]);

const result = verifyRequest({
  secret: token,
  method: 'POST',
  path: '/api/internal/executions/trc_abc123/complete',
  body,
  headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
});

const checks: [string, boolean, string][] = [
  ['signature verifies against the control plane verifier', result.ok, result.ok ? '' : (result as { reason: string }).reason],
  ['the body parses as the callback schema shape', (() => { try { JSON.parse(body); return true; } catch { return false; } })(), ''],
  ['every skipped action carries a reason',
    JSON.parse(body).actions_skipped.every((a: { reason?: string }) => !!a && !!a.reason), ''],
  ['unsupported evidence is marked unsupported, not dropped',
    JSON.parse(body).evidence.some((e: { supported: boolean }) => e.supported === false), ''],
  ['the payload carries no organization or lead id',
    !('org_id' in JSON.parse(body)) && !('lead_id' in JSON.parse(body)) && !('organization_id' in JSON.parse(body)), ''],
];

// A tampered body must not verify.
const tampered = body.replace('"score":90', '"score":100');
const tamperResult = verifyRequest({
  secret: token, method: 'POST', path: '/api/internal/executions/trc_abc123/complete',
  body: tampered, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
});
checks.push(['a tampered body fails verification', !tamperResult.ok && tampered !== body, '']);

// The key really is per-execution: another execution's token must not verify.
const otherToken = callbackTokenFor(MASTER, '00000000-0000-4000-8000-000000000000');
const otherResult = verifyRequest({
  secret: otherToken, method: 'POST', path: '/api/internal/executions/trc_abc123/complete',
  body, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
});
checks.push(["another execution's token does not verify", !otherResult.ok, '']);

// And the raw HMAC matches node:crypto, independently of our own verifier.
const canonical = `v1:POST:/api/internal/executions/trc_abc123/complete:${item['timestamp']}:${item['nonce']}:${
  require('node:crypto').createHash('sha256').update(body, 'utf8').digest('hex')
}`;
const expected = 'v1=' + createHmac('sha256', token).update(canonical).digest('hex');
checks.push(['the signature equals node:crypto over the canonical string', item['signature'] === expected, '']);

let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\n  Build Callback agrees with the control plane verifier\n' : `\n  ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
