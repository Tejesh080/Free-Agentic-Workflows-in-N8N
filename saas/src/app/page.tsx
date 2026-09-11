import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';
import { loadOverview } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export default async function OverviewPage() {
  const session = await requireSession();
  const m = await withOrgContext(session.principal, (tx) => loadOverview(tx));

  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        Every number here is read from this organization&apos;s own rows under row level
        security. Where there is nothing to measure yet, the tile says so rather than
        showing a zero that looks like a result.
      </p>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="tile">
          <div className="label">Leads processed</div>
          <div className="value">{m.leadsTotal}</div>
          <div className="sub">{m.runs.succeeded} runs finished, {m.runs.failed} failed</div>
        </div>
        <div className="tile">
          <div className="label">Qualified rate</div>
          <div className="value">{pct(m.qualifiedRate)}</div>
          <div className="sub">HOT or WARM, of all leads</div>
        </div>
        <div className="tile">
          <div className="label">Awaiting approval</div>
          <div className="value">{m.pendingApprovals}</div>
          <div className="sub">
            {m.expiredApprovals > 0 ? `${m.expiredApprovals} expired unactioned` : 'none expired'}
          </div>
        </div>
        <div className="tile">
          <div className="label">Evidence supported</div>
          <div className="value">
            {m.evidence ? pct(m.evidence.supported / m.evidence.total) : '—'}
          </div>
          <div className="sub">
            {m.evidence
              ? `${m.evidence.supported} of ${m.evidence.total} quotes located in source`
              : 'no evidence recorded yet'}
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Tier distribution</h2>
          <table>
            <tbody>
              {(['HOT', 'WARM', 'COLD', 'DISQUALIFIED'] as const).map((tier) => {
                const n = m.tiers[tier];
                const share = m.leadsTotal > 0 ? n / m.leadsTotal : 0;
                return (
                  <tr key={tier}>
                    <td style={{ width: 120 }}>
                      <span className={`pill ${tier}`}>{tier}</span>
                    </td>
                    <td className="mono" style={{ width: 52 }}>{n}</td>
                    <td>
                      <div className="score-bar" aria-hidden="true">
                        <i style={{ width: `${Math.round(share * 100)}%` }} />
                      </div>
                    </td>
                    <td className="mono muted" style={{ width: 48 }}>{pct(share)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Run health</h2>
          <dl className="kv">
            <dt>In flight</dt>
            <dd className="mono">{m.runs.inFlight}</dd>
            <dt>Latency p50</dt>
            <dd className="mono">{m.latency.p50 === null ? '—' : `${m.latency.p50} ms`}</dd>
            <dt>Latency p95</dt>
            <dd className="mono">{m.latency.p95 === null ? '—' : `${m.latency.p95} ms`}</dd>
            <dt>Model spend</dt>
            <dd className="mono">${m.costUsd.toFixed(4)}</dd>
            <dt>CRM</dt>
            <dd>
              {m.crm ? (
                <>
                  <span className={`pill ${m.crm.status === 'connected' ? 'ok' : 'warn'}`}>
                    {m.crm.provider}: {m.crm.status}
                  </span>{' '}
                  <span className="muted">
                    {m.crm.lastSuccessAt
                      ? `last success ${new Date(m.crm.lastSuccessAt).toISOString().slice(0, 16).replace('T', ' ')}`
                      : 'no successful write yet'}
                  </span>
                </>
              ) : (
                <span className="muted">no integration configured</span>
              )}
            </dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h2>Outcomes</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Outcomes feed evaluation. They never change production scoring on their own.
          </span>
        </div>
        {m.outcomes.length === 0 ? (
          <p className="muted">
            No outcomes recorded. Until there are, tier quality and conversion cannot be
            measured, and this product will not pretend otherwise.
          </p>
        ) : (
          <table>
            <thead>
              <tr><th>State</th><th>Leads</th></tr>
            </thead>
            <tbody>
              {m.outcomes.map((o) => (
                <tr key={o.state}>
                  <td className="mono">{o.state}</td>
                  <td className="mono">{o.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
