/**
 * Installs the control-plane integration into workflow 14.
 *
 *   node scripts/patch-wf14.mjs
 *
 * Three changes, each idempotent so the script can be re-run:
 *
 *  1. Normalise Intake learns the control plane's dispatch envelope, and carries
 *     allowed_actions, callback_url and callback_token through.
 *  2. Outreach Wanted? gains a second condition: the API states the ceiling and
 *     the engine may only narrow it, so outreach also requires the control plane
 *     to have permitted it.
 *  3. A signed completion callback is appended after the decision receipt.
 */
import { readFileSync } from 'node:fs';
import { SWARM_HMAC_SNIPPET } from './n8n-hmac-snippet.js';
import { BUILD_CALLBACK_BODY } from './wf14-build-callback.js';

const BASE = process.env.N8N_BASE_URL;
const KEY = process.env.N8N_API_KEY;
const WF = 'LBqg8FFAh9D1rWXu';
if (!BASE || !KEY) {
  console.error('N8N_BASE_URL and N8N_API_KEY must be set');
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: { 'X-N8N-API-KEY': KEY, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

const wf = await api(`/workflows/${WF}`);
const node = (name) => wf.nodes.find((n) => n.name === name);

// ---------------------------------------------------------------------------
// 1. Dispatch envelope
// ---------------------------------------------------------------------------
const intake = node('Normalise Intake');
let code = intake.parameters.jsCode;

const ANCHOR = 'const headers = raw.headers || {};';
// Repair a previous patch that declared the envelope before `body` existed,
// which is a temporal dead zone error rather than a missing feature.
const misordered = code.indexOf('const envelope =') < code.indexOf('const body = raw.body');
if (misordered && code.includes('fromControlPlane')) {
  const start = code.indexOf('// A fourth shape') - 1;
  const end = code.indexOf('const fromControlPlane = envelope !== null;');
  code = code.slice(0, start) + code.slice(end + 'const fromControlPlane = envelope !== null;'.length);
  code = code.replace('const lead = fromControlPlane ?', 'const lead = fromSubWorkflow ?')
             .replace(' : (fromSubWorkflow ? parseJson(raw.lead, {}) : (body || raw));', ' parseJson(raw.lead, {}) : (body || raw);')
             .replace(/const options = fromControlPlane[\s\S]*?: fromSubWorkflow/, 'const options = fromSubWorkflow');
  console.log('  ~ removed a mis-ordered envelope block before re-applying');
}

if (!code.includes('fromControlPlane') || misordered) {
  code = code.replace(
    ANCHOR,
    `${ANCHOR}

// A fourth shape: the control plane's dispatch envelope. Recognised by carrying
// both a trace id and a lead OBJECT, which neither the webhook shape (lead
// fields at the top level) nor the sub-workflow shape (lead as a JSON string)
// does.
//
// Note which field is NOT trusted from it: nothing here decides authorization.
// organization_id arrives as execution data so this engine's own per-tenant
// state is scoped correctly, and the control plane already settled whether the
// caller may act on it before the payload was built.
const envelope = body && body.trace_id && body.lead && typeof body.lead === "object" ? body : null;
const fromControlPlane = envelope !== null;`,
  );

  code = code.replace(
    'const lead = fromSubWorkflow ? parseJson(raw.lead, {}) : (body || raw);',
    'const lead = fromControlPlane ? envelope.lead : (fromSubWorkflow ? parseJson(raw.lead, {}) : (body || raw));',
  );

  // The control plane supplies these directly rather than through `options`.
  code = code.replace(
    'const options = fromSubWorkflow',
    `const options = fromControlPlane
  ? {
      dry_run: String(envelope.dry_run),
      tenant_id: envelope.organization_id,
      trace_id: envelope.trace_id,
      enrich: "false"
    }
  : fromSubWorkflow`,
  );

  code = code.replace(
    '  entry: fromSubWorkflow ? "sub_workflow" : (body ? "webhook" : "manual"),',
    `  entry: fromControlPlane ? "control_plane" : (fromSubWorkflow ? "sub_workflow" : (body ? "webhook" : "manual")),
  // Carried through so the completion can be signed and delivered. Absent for
  // every other entry shape, and the callback is then skipped rather than faked.
  callback_url: fromControlPlane ? String(envelope.callback_url || "") : "",
  callback_token: fromControlPlane ? String(envelope.callback_token || "") : "",
  saas_execution_id: fromControlPlane ? String(envelope.execution_id || "") : "",
  // The ceiling the control plane set. The engine may narrow this; it may never
  // widen it. An entry shape that does not set it is unconstrained by it.
  allowed_actions: fromControlPlane && Array.isArray(envelope.allowed_actions)
    ? envelope.allowed_actions.map(function (a) { return String(a); })
    : null,
  outreach_permitted: fromControlPlane && Array.isArray(envelope.allowed_actions)
    ? (envelope.allowed_actions.indexOf("outreach_draft") !== -1 || envelope.allowed_actions.indexOf("outreach_send") !== -1)
    : true,`,
  );
  intake.parameters.jsCode = code;
  console.log('  + Normalise Intake understands the dispatch envelope');
} else {
  console.log('  = Normalise Intake already patched');
}

// ---------------------------------------------------------------------------
// 2. Outreach also requires the control plane's permission
// ---------------------------------------------------------------------------
const wanted = node('Outreach Wanted?');
const conds = wanted.parameters.conditions.conditions;
if (!conds.some((c) => c.id === 'ow2')) {
  conds.push({
    id: 'ow2',
    leftValue: '={{ $("Normalise Intake").first().json.outreach_permitted }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true },
  });
  console.log('  + Outreach Wanted? now also requires allowed_actions to permit it');
} else {
  console.log('  = Outreach Wanted? already patched');
}

// ---------------------------------------------------------------------------
// 3. Signed completion callback
// ---------------------------------------------------------------------------
const buildBody = BUILD_CALLBACK_BODY.replace('__HMAC__', SWARM_HMAC_SNIPPET);

const ensure = (spec) => {
  const existing = node(spec.name);
  if (existing) {
    Object.assign(existing, spec);
    return false;
  }
  wf.nodes.push(spec);
  return true;
};

const added = [
  ensure({
    id: 'cb-build-0001', name: 'Build Callback', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [2320, 1080],
    parameters: { jsCode: buildBody },
    notes: 'Signs the completion with the per-execution callback_token from the dispatch payload. Hand-rolled SHA-256/HMAC because n8n Code nodes cannot rely on require("crypto"); verified against node:crypto by scripts/verify-callback-node.ts.',
  }),
  ensure({
    id: 'cb-if-000001', name: 'Callback Wanted?', type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [2100, 1080],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{
          id: 'cw1',
          leftValue: '={{ $("Normalise Intake").first().json.callback_url }}',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
    notes: 'Only a run dispatched by the control plane has somewhere to report back to. A direct webhook post or a suite run skips the callback rather than inventing a destination.',
  }),
  ensure({
    id: 'cb-send-00001', name: 'Send Callback', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [2540, 1080],
    parameters: {
      method: 'POST',
      url: '={{ $json.callback_url }}',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'x-swarm-signature', value: '={{ $json.signature }}' },
          { name: 'x-swarm-timestamp', value: '={{ $json.timestamp }}' },
          { name: 'x-swarm-nonce', value: '={{ $json.nonce }}' },
          { name: 'content-type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      // The exact bytes that were signed. Re-serialising here would invalidate
      // the signature, which is the point of signing the raw body.
      jsonBody: '={{ $json.callback_body }}',
      options: { timeout: 15000 },
    },
    notes: 'Delivers the signed completion. A failure here fails the execution on purpose: the control plane not learning the result is a real failure, and workflow 16 records it for replay.',
  }),
].filter(Boolean).length;

// Rewire: Record Decision Receipt -> Callback Wanted? -> (true) Build -> Send -> Return
//                                                     -> (false) Return
wf.connections['Record Decision Receipt'] = { main: [[{ node: 'Callback Wanted?', type: 'main', index: 0 }]] };
wf.connections['Callback Wanted?'] = {
  main: [
    [{ node: 'Build Callback', type: 'main', index: 0 }],
    [{ node: 'Return Swarm Response', type: 'main', index: 0 }],
  ],
};
wf.connections['Build Callback'] = { main: [[{ node: 'Send Callback', type: 'main', index: 0 }]] };
wf.connections['Send Callback'] = { main: [[{ node: 'Return Swarm Response', type: 'main', index: 0 }]] };

await api(`/workflows/${WF}`, {
  method: 'PUT',
  body: JSON.stringify({
    name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {},
  }),
});
console.log(`  + ${added} callback node(s) added/updated and rewired`);
console.log('\n  workflow 14 patched — publish it to activate\n');
