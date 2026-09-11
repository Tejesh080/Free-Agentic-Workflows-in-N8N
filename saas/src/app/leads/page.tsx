import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

interface Row {
  public_id: string;
  email: string | null;
  company_name: string | null;
  job_title: string | null;
  status: string;
  source: string;
  latest_score: number | null;
  latest_tier: string | null;
  created_at: Date;
  latest_trace_id: string | null;
  pending_approvals: number;
  latest_outcome: string | null;
}

const TIERS = ['HOT', 'WARM', 'COLD', 'DISQUALIFIED'] as const;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; q?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const tier = TIERS.includes(params.tier as (typeof TIERS)[number]) ? params.tier! : null;
  const q = (params.q ?? '').trim() || null;

  const rows = await withOrgContext(session.principal, (tx) =>
    tx.query<Row>(
      `select l.public_id, l.email, l.company_name, l.job_title, l.status, l.source,
              l.latest_score, l.latest_tier, l.created_at,
              e.trace_id as latest_trace_id,
              (select count(*) from approval_requests a
                where a.lead_id = l.id and a.status = 'pending' and a.expires_at > now())::int
                as pending_approvals,
              (select o.state::text from lead_outcomes o
                where o.lead_id = l.id order by o.occurred_at desc limit 1) as latest_outcome
         from leads l
         left join executions e on e.id = l.latest_execution_id
        where l.archived_at is null
          and ($1::lead_tier is null or l.latest_tier = $1::lead_tier)
          and ($2::text is null or l.email ilike '%' || $2 || '%' or l.company_name ilike '%' || $2 || '%')
        order by l.created_at desc
        limit 100`,
      [tier, q],
    ),
  );

  return (
    <>
      <h1>Leads</h1>
      <p className="lede">
        {rows.length} lead{rows.length === 1 ? '' : 's'} in {session.orgName}. The query runs
        under this organization&apos;s row level security context, so there is no tenant filter
        in the application code that could be forgotten.
      </p>

      <form className="card row" method="get" style={{ gap: 10 }}>
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="email or company"
          aria-label="Search leads"
          style={{
            font: 'inherit', padding: '6px 10px', borderRadius: 6,
            border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
            color: 'var(--text)', minWidth: 220,
          }}
        />
        <select
          name="tier"
          defaultValue={tier ?? ''}
          aria-label="Filter by tier"
          style={{
            font: 'inherit', padding: '6px 10px', borderRadius: 6,
            border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
            color: 'var(--text)',
          }}
        >
          <option value="">All tiers</option>
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="btn" type="submit">Filter</button>
        {(tier || q) && <a href="/leads" style={{ fontSize: 13 }}>Clear</a>}
      </form>

      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Company</th>
              <th>Tier</th>
              <th>Score</th>
              <th>Status</th>
              <th>Source</th>
              <th>Latest action</th>
              <th>Outcome</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted">No leads match.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.public_id}>
                <td>
                  <a href={`/leads/${r.public_id}`}>{r.email ?? r.public_id}</a>
                  <div className="muted" style={{ fontSize: 12 }}>{r.job_title ?? ''}</div>
                </td>
                {/* Company names are caller-supplied. React escapes them; one of the
                    seeded leads is literally a script tag, which renders as text. */}
                <td>{r.company_name ?? <span className="muted">—</span>}</td>
                <td>
                  {r.latest_tier
                    ? <span className={`pill ${r.latest_tier}`}>{r.latest_tier}</span>
                    : <span className="pill mute">unscored</span>}
                </td>
                <td className="mono">{r.latest_score ?? '—'}</td>
                <td><span className="pill mute">{r.status}</span></td>
                <td className="mono muted">{r.source}</td>
                <td>
                  {r.pending_approvals > 0
                    ? <span className="pill warn">approval pending</span>
                    : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                </td>
                <td className="mono muted">{r.latest_outcome ?? '—'}</td>
                <td className="mono muted">
                  {new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
