import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';
import { decide } from './actions';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  action: string;
  status: string;
  risk_level: string;
  policy_reason: string;
  payload: Record<string, unknown>;
  requested_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decision_note: string | null;
  executed_at: Date | null;
  is_expired: boolean;
  lead_id: string | null;
  lead_email: string | null;
  company_name: string | null;
  latest_tier: string | null;
  latest_score: number | null;
  decided_by_email: string | null;
}

const SELECT = `
  select a.id, a.action, a.status::text as status, a.risk_level, a.policy_reason, a.payload,
         a.requested_at, a.expires_at, a.decided_at, a.decision_note, a.executed_at,
         a.expires_at <= now() as is_expired,
         l.public_id as lead_id, l.email as lead_email, l.company_name,
         l.latest_tier::text as latest_tier, l.latest_score,
         u.email as decided_by_email
    from approval_requests a
    left join leads l on l.id = a.lead_id
    left join users u on u.id = a.decided_by`;

const PENDING_QUERY = `${SELECT} where a.status = 'pending' order by a.requested_at desc limit 50`;
const HISTORY_QUERY = `${SELECT} where a.status <> 'pending' order by coalesce(a.decided_at, a.requested_at) desc limit 50`;

export default async function ApprovalsPage() {
  const session = await requireSession();

  const { pending, history } = await withOrgContext(session.principal, async (tx) => ({
    pending: await tx.query<Row>(PENDING_QUERY),
    history: await tx.query<Row>(HISTORY_QUERY),
  }));

  const canDecide = ['owner', 'admin', 'member'].includes(session.principal.role);

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">
        Anything that leaves the building stops here first. Approval state lives in
        Postgres, not in the transport that delivered the notification, so the record of
        who authorised what survives changing or losing the notification channel.
      </p>

      {!canDecide && (
        <div className="notice">
          Your role is <strong>{session.principal.role}</strong>, which can read this queue
          but not decide. The database policy enforces that, not this page.
        </div>
      )}

      <h2>Pending</h2>
      {pending.length === 0 ? (
        <div className="card"><p className="muted">Nothing is waiting.</p></div>
      ) : (
        pending.map((a) => (
          <div className="card" key={a.id}>
            <div className="spread">
              <div>
                <div className="row">
                  <span className={`pill ${a.risk_level === 'CRITICAL' || a.risk_level === 'HIGH' ? 'bad' : 'warn'}`}>
                    {a.risk_level}
                  </span>
                  <strong>{a.action}</strong>
                  {a.latest_tier && <span className={`pill ${a.latest_tier}`}>{a.latest_tier}</span>}
                  {a.latest_score !== null && (
                    <span className="mono muted">score {a.latest_score}</span>
                  )}
                </div>
                <div className="dim" style={{ marginTop: 4 }}>
                  {a.lead_id ? (
                    <a href={`/leads/${a.lead_id}`}>{a.lead_email ?? a.lead_id}</a>
                  ) : (
                    <span className="muted">no lead attached</span>
                  )}
                  {a.company_name ? ` · ${a.company_name}` : ''}
                </div>
              </div>
              <div className="mono muted" style={{ fontSize: 12, textAlign: 'right' }}>
                requested {new Date(a.requested_at).toISOString().slice(0, 16).replace('T', ' ')}
                <br />
                {a.is_expired ? (
                  <span className="pill bad">expired</span>
                ) : (
                  <>expires {new Date(a.expires_at).toISOString().slice(0, 16).replace('T', ' ')}</>
                )}
              </div>
            </div>

            <div className="notice info" style={{ margin: '12px 0' }}>
              <strong>Why a human is being asked:</strong> {a.policy_reason}
            </div>

            <h3>Exactly what will be sent</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              Frozen when the request was made. The database refuses any change to it, so
              this approval cannot be harvested and applied to different content.
            </p>
            <pre className="json">{JSON.stringify(a.payload, null, 2)}</pre>

            {canDecide && !a.is_expired && (
              <form action={decide} className="row" style={{ marginTop: 12 }}>
                <input type="hidden" name="approval_id" value={a.id} />
                <input
                  type="text"
                  name="note"
                  placeholder="note (optional)"
                  aria-label="Decision note"
                  style={{
                    font: 'inherit', padding: '6px 10px', borderRadius: 6, flex: '1 1 240px',
                    border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
                    color: 'var(--text)',
                  }}
                />
                <button className="btn primary" type="submit" name="decision" value="approved">
                  Approve
                </button>
                <button className="btn danger" type="submit" name="decision" value="rejected">
                  Reject
                </button>
              </form>
            )}
            {a.is_expired && (
              <p className="muted" style={{ fontSize: 13 }}>
                This request aged out and can no longer be approved. Expiry is evaluated when
                it is read, so it never becomes actionable again just because no sweeper ran.
              </p>
            )}
          </div>
        ))
      )}

      <h2 style={{ marginTop: 24 }}>History</h2>
      <div className="card scroll-x">
        {history.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Action</th><th>Lead</th><th>Status</th><th>Decided by</th>
                <th>Note</th><th>Executed</th><th>Decided</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td>{a.lead_id ? <a href={`/leads/${a.lead_id}`}>{a.lead_email}</a> : '—'}</td>
                  <td>
                    <span className={`pill ${a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : 'mute'}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="muted">{a.decided_by_email ?? '—'}</td>
                  <td className="muted">{a.decision_note ?? '—'}</td>
                  <td className="mono muted">
                    {a.executed_at
                      ? new Date(a.executed_at).toISOString().slice(0, 16).replace('T', ' ')
                      : 'not yet'}
                  </td>
                  <td className="mono muted">
                    {a.decided_at
                      ? new Date(a.decided_at).toISOString().slice(0, 16).replace('T', ' ')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
