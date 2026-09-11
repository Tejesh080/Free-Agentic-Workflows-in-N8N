import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';
import { loadLeadDetail } from '@/lib/leads/detail';
import { DecisionTrace, type TraceReceipt } from './decision-trace';

export const dynamic = 'force-dynamic';

function ts(value: unknown): string {
  if (!value) return '—';
  return new Date(value as string).toISOString().slice(0, 19).replace('T', ' ');
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const session = await requireSession();
  const { publicId } = await params;

  const detail = await withOrgContext(session.principal, (tx) => loadLeadDetail(tx, publicId));
  // A lead in another organization arrives here as undefined, exactly like one
  // that never existed, and both render the same 404.
  if (!detail) notFound();

  const lead = detail.lead as Record<string, unknown>;
  const receipt = detail.receipt as (TraceReceipt & Record<string, unknown>) | null;
  const latestExecution = detail.executions[0] as Record<string, unknown> | undefined;
  const pending = detail.approvals.find((a) => a['status'] === 'pending') as
    | Record<string, unknown>
    | undefined;

  const tier = (lead['latest_tier'] as string | null) ?? null;
  const model = (receipt?.['model_metadata'] ?? {}) as Record<string, unknown>;
  const prompts = (receipt?.['prompt_versions'] ?? {}) as Record<string, string>;

  return (
    <>
      <div className="spread" style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{String(lead['email'] ?? publicId)}</h1>
        <div className="row">
          {tier && <span className={`pill ${tier}`}>{tier}</span>}
          <span className="mono dim">score {String(lead['latest_score'] ?? '—')}</span>
        </div>
      </div>
      <p className="lede" style={{ marginBottom: 18 }}>
        {String(lead['job_title'] ?? '')}
        {lead['company_name'] ? ` at ${String(lead['company_name'])}` : ''} ·{' '}
        <span className="mono muted">{publicId}</span>
      </p>

      {pending && (
        <div className="notice">
          <strong>{String(pending['action'])}</strong> is held for approval —{' '}
          {String(pending['policy_reason'])}{' '}
          <a href="/approvals">Review in approvals →</a>
        </div>
      )}

      <div className="card">
        <div className="spread">
          <h2>Decision trace</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {String(latestExecution?.['trace_id'] ?? '')}
          </span>
        </div>
        <DecisionTrace
          receipt={receipt}
          executionStatus={(latestExecution?.['status'] as string) ?? null}
          dryRun={Boolean(latestExecution?.['dry_run'])}
          evidenceCount={detail.evidence.length}
          pendingApproval={
            pending
              ? {
                  action: String(pending['action']),
                  policy_reason: String(pending['policy_reason']),
                }
              : null
          }
          source={String(lead['source'] ?? 'api')}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Score breakdown</h2>
          {receipt && receipt.score_components.length > 0 ? (
            <table>
              <thead>
                <tr><th>Signal</th><th>Value</th><th>Points</th></tr>
              </thead>
              <tbody>
                {receipt.score_components.map((c) => (
                  <tr key={c.signal}>
                    <td className="mono">{c.signal}</td>
                    <td className="mono">{c.value}</td>
                    <td className="mono" style={{ color: c.points < 0 ? 'var(--hot)' : undefined }}>
                      {c.points > 0 ? `+${c.points}` : c.points}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}><strong>Total</strong></td>
                  <td className="mono"><strong>{receipt.score ?? '—'}</strong></td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">No score components recorded.</p>
          )}
        </div>

        <div className="card">
          <h2>Reproducibility</h2>
          <dl className="kv">
            <dt>Rubric version</dt>
            <dd className="mono">{String(receipt?.['rubric_version'] ?? '—')}</dd>
            <dt>Provider / model</dt>
            <dd className="mono">
              {String(model['provider'] ?? '—')} / {String(model['model'] ?? '—')}
            </dd>
            <dt>Model config</dt>
            <dd className="mono">
              {model['reasoning_effort']
                ? `reasoning_effort=${String(model['reasoning_effort'])}`
                : model['temperature'] !== undefined
                  ? `temperature=${String(model['temperature'])}`
                  : '—'}
            </dd>
            <dt>Prompt versions</dt>
            <dd className="mono">
              {Object.keys(prompts).length === 0
                ? '—'
                : Object.entries(prompts).map(([k, v]) => (
                    <div key={k}>{k} @ {v}</div>
                  ))}
            </dd>
            <dt>Tokens</dt>
            <dd className="mono">
              {model['input_tokens'] !== undefined
                ? `${String(model['input_tokens'])} in / ${String(model['output_tokens'] ?? '?')} out`
                : '—'}
            </dd>
            <dt>Mode</dt>
            <dd>
              <span className={`pill ${latestExecution?.['dry_run'] ? 'mute' : 'warn'}`}>
                {latestExecution?.['dry_run'] ? 'dry run' : 'live'}
              </span>
            </dd>
            <dt>Latency</dt>
            <dd className="mono">
              {latestExecution?.['latency_ms'] ? `${String(latestExecution['latency_ms'])} ms` : '—'}
            </dd>
            <dt>Cost</dt>
            <dd className="mono">
              {latestExecution?.['cost_usd'] ? `$${String(latestExecution['cost_usd'])}` : '—'}
            </dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h2>Evidence</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Quotes are verbatim from the lead&apos;s own text and are rendered as inert text.
          </span>
        </div>
        {detail.evidence.length === 0 ? (
          <p className="muted">No evidence recorded.</p>
        ) : (
          <div className="evidence">
            {detail.evidence.map((e, i) => {
              const supported = Boolean(e['supported']);
              const points = Number(e['points'] ?? 0);
              return (
                <div
                  key={`${String(e['signal'])}-${i}`}
                  className={`evidence-row ${supported ? 'supported' : 'unsupported'}`}
                >
                  <div className="evidence-head">
                    <span className="signal">{String(e['signal'])}</span>
                    <span className="value">{String(e['value'])}</span>
                    <span className={`pill ${supported ? 'ok' : 'bad'}`}>
                      {supported ? 'supported' : 'unsupported'}
                    </span>
                    <span className="points" style={{ color: points < 0 ? 'var(--hot)' : undefined }}>
                      {points > 0 ? `+${points}` : points}
                    </span>
                  </div>
                  {e['quote'] ? (
                    <p className="quote">{String(e['quote'])}</p>
                  ) : (
                    <p className="quote muted">no quote returned for this signal</p>
                  )}
                  {!supported && Boolean(e['quote']) && (
                    <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                      This span was not found in the source text, so the signal earned no
                      points and the rubric&apos;s penalty applied instead.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Lead data as received</h2>
          <dl className="kv">
            <dt>Email</dt><dd>{String(lead['email'] ?? '—')}</dd>
            <dt>Company</dt><dd>{String(lead['company_name'] ?? '—')}</dd>
            <dt>Title</dt><dd>{String(lead['job_title'] ?? '—')}</dd>
            <dt>Source</dt><dd className="mono">{String(lead['source'] ?? '—')}</dd>
            <dt>Received</dt><dd className="mono">{ts(lead['created_at'])}</dd>
          </dl>
          <h3 style={{ marginTop: 14 }}>Notes</h3>
          {/* Free text from the caller. This is where indirect prompt injection
              arrives; it is displayed as data, and no part of the UI interprets it. */}
          <p className="quote" style={{ fontStyle: 'normal' }}>
            {String(lead['notes'] ?? '—')}
          </p>
        </div>

        <div className="card">
          <h2>Timeline</h2>
          <table>
            <tbody>
              {detail.timeline.map((t, i) => (
                <tr key={i}>
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                    {t.at.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td>
                    {t.summary}
                    {t.kind === 'approval_requested' && t.detail?.['reason'] ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {String(t.detail['reason'])}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail.outcomes.length > 0 && (
        <div className="card">
          <h2>Outcomes</h2>
          <table>
            <thead>
              <tr><th>State</th><th>Source</th><th>Value</th><th>Occurred</th></tr>
            </thead>
            <tbody>
              {detail.outcomes.map((o, i) => (
                <tr key={i}>
                  <td className="mono">{String(o['state'])}</td>
                  <td className="mono muted">{String(o['source'])}</td>
                  <td className="mono">{o['value_usd'] ? `$${String(o['value_usd'])}` : '—'}</td>
                  <td className="mono muted">{ts(o['occurred_at'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Full decision receipt (JSON)
          </summary>
          <p className="muted" style={{ fontSize: 12 }}>
            The stored record, unmodified. It holds auditable inputs, outputs and
            deterministic derivations — not model reasoning traces, which are neither
            verifiable nor a decision input.
          </p>
          <pre className="json">{JSON.stringify(receipt, null, 2)}</pre>
        </details>
      </div>
    </>
  );
}
