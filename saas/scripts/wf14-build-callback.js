/**
 * Body of the n8n Code node "Build Callback" in workflow 14.
 *
 * Kept here rather than only inside n8n so it is reviewable, diffable, and
 * testable: scripts/verify-callback-node.ts runs this exact source against the
 * control plane's own verifyRequest() to prove the two agree before it is
 * deployed.
 *
 * The signing key is the per-execution callback_token handed over in the
 * dispatch payload, never a shared secret. See callbackTokenFor().
 */
module.exports.BUILD_CALLBACK_BODY = `
__HMAC__

const intake = $("Normalise Intake").first().json;
const response = $("Build Swarm Response").first().json;

// No callback_url means this run did not come from the control plane (a direct
// webhook post, or the test suite). Emit a marker the IF node routes on.
if (!intake.callback_url || !intake.callback_token) {
  return [{ json: { callback_skipped: true, reason: "no callback_url in the dispatch payload" } }];
}

const q = response.qualification || {};
const scoring = q.scoring || {};
const grounding = q.grounding || {};
const crm = response.crm || {};
const outreach = response.outreach || {};

// Evidence: every quoted span the model returned, marked with whether the
// deterministic check found it in the source text. The unsupported ones are
// kept, not dropped — why a lead lost points is part of the audit trail.
const unsupported = {};
(grounding.unsupported_evidence || []).forEach(function (e) {
  unsupported[String(e.signal) + "|" + String(e.quote)] = true;
});
const evidence = ((q.signals || {}).evidence || []).map(function (e) {
  const key = String(e.signal) + "|" + String(e.quote);
  return {
    signal: String(e.signal || ""),
    value: String((q.signals || {})[e.signal] || ""),
    quote: e.quote === undefined ? null : String(e.quote),
    source_field: "message",
    supported: !unsupported[key],
    points: 0
  };
});

const components = (scoring.components || []).map(function (c) {
  return {
    signal: String(c.component || ""),
    value: String(c.detail || ""),
    points: Math.round(Number(c.points) || 0),
    supported: true
  };
});
(scoring.modifiers || []).forEach(function (m) {
  components.push({
    signal: String(m.modifier || "modifier"),
    value: String(m.reason || ""),
    points: Math.round(Number(m.points) || 0),
    supported: false
  });
});

const taken = [];
if (crm.contact_id) {
  taken.push({ action: "crm_upsert_contact", object_id: String(crm.contact_id), status: String(crm.contact_status || "") });
}
if (crm.deal_id) {
  taken.push({ action: "crm_create_deal", object_id: String(crm.deal_id), status: String(crm.deal_status || "") });
}
if (crm.task_id) {
  taken.push({ action: "crm_create_task", object_id: String(crm.task_id), status: String(crm.task_status || "") });
}
if (outreach.sent) {
  taken.push({ action: "outreach_send", status: String(outreach.status || "") });
}

// Every step that did not happen carries the reason it did not happen. A
// skipped step with no reason is a missing audit record, and the control
// plane's schema refuses it.
const skipped = [];
(response.steps || []).forEach(function (s) {
  if (!s.done) {
    skipped.push({
      action: String(s.step || "unknown"),
      reason: String(s.detail || "no reason recorded")
    });
  }
});
if (!outreach.attempted && !skipped.some(function (s) { return s.action === "outreach"; })) {
  skipped.push({ action: "outreach", reason: String(outreach.detail || "outreach was not attempted") });
}

const payload = {
  status: response.ok === false ? "failed" : "succeeded",
  decision: String(response.outcome || "unknown"),
  score: q.score === undefined || q.score === null ? null : Math.round(Number(q.score)),
  tier: q.tier || null,
  rubric_version: scoring.rubric_version || null,
  prompt_versions: (q.provenance && q.provenance.prompt_sha)
    ? { "revenue/lead-qualifier": String(q.provenance.prompt_sha) }
    : {},
  model_metadata: (q.provenance && q.provenance.model_provider)
    ? { provider: String(q.provenance.model_provider) }
    : {},
  score_components: components,
  evidence: evidence,
  verification: q.verification || {},
  governance: outreach.governance || {},
  actions_taken: taken,
  actions_skipped: skipped,
  crm_result: crm,
  engine_execution_id: String($execution.id)
};

const body = JSON.stringify(payload);

// The signature binds method, path, time, a single-use nonce and a digest of
// the exact bytes below. The control plane recomputes it over the raw body it
// receives, so re-serialising anywhere in between would invalidate it.
const url = intake.callback_url;
const path = url.replace(/^https?:\\/\\/[^/]+/, "");
const timestamp = String(Math.floor(Date.now() / 1000));
let nonce = "";
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
for (let i = 0; i < 24; i++) { nonce += alphabet[Math.floor(Math.random() * alphabet.length)]; }

const digest = sha256Hex(body);
const canonical = "v1:POST:" + path + ":" + timestamp + ":" + nonce + ":" + digest;
const signature = "v1=" + hmacSha256Hex(String(intake.callback_token), canonical);

return [{ json: {
  callback_skipped: false,
  callback_url: url,
  callback_body: body,
  signature: signature,
  timestamp: timestamp,
  nonce: nonce,
  trace_id: String(intake.trace_id || "")
} }];
`;
