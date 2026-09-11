import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

interface Run {
  id: string;
  dataset_version: string;
  dataset_size: number;
  sample_seed: string | null;
  segment: string | null;
  production_metrics: Record<string, number>;
  candidate_metrics: Record<string, number>;
  gate_decision: string;
  gate_reasons: string[];
  created_at: Date;
  production_version: string | null;
  candidate_version: string | null;
}

interface Rubric {
  id: string;
  version: string;
  status: string;
  notes: string | null;
  published_at: Date | null;
  archived_at: Date | null;
  decisions: number;
}

// The keys workflow 15's promotion gate actually emits. Adding a metric here
// without the harness producing it would render a blank row, which is why the
// table skips any metric absent from either side rather than showing a zero.
const METRICS = [
  { key: 'accuracy', label: 'Tier accuracy', higherIsBetter: true },
  { key: 'hot_precision', label: 'HOT precision', higherIsBetter: true },
  { key: 'hot_recall', label: 'HOT recall', higherIsBetter: true },
  { key: 'hot_conversion', label: 'HOT conversion', higherIsBetter: true },
] as const;

// Deliberately not in the table above: predicted_hot is a count, and "more HOT
// is better" is the exact mistake that produced this candidate's precision
// regression. It is reported as context, without a direction.
const CONTEXT_METRICS = [{ key: 'predicted_hot', label: 'predicted HOT' }] as const;

export default async function EvaluationsPage() {
  const session = await requireSession();

  const { runs, rubrics } = await withOrgContext(session.principal, async (tx) => ({
    runs: await tx.query<Run>(
      `select e.id, e.dataset_version, e.dataset_size, e.sample_seed, e.segment,
              e.production_metrics, e.candidate_metrics, e.gate_decision, e.gate_reasons, e.created_at,
              p.version as production_version, c.version as candidate_version
         from evaluation_runs e
         left join rubric_versions p on p.id = e.production_rubric_id
         left join rubric_versions c on c.id = e.candidate_rubric_id
        order by e.created_at desc limit 20`,
    ),
    rubrics: await tx.query<Rubric>(
      `select r.id, r.version, r.status::text as status, r.notes, r.published_at, r.archived_at,
              (select count(*) from decision_receipts d where d.rubric_version_id = r.id)::int as decisions
         from rubric_versions r order by r.created_at desc`,
    ),
  }));

  return (
    <>
      <h1>Evaluations</h1>
      <p className="lede">
        A candidate rubric is promoted by arithmetic or not at all. The gate requires no
        regression on any tracked metric and an improvement on at least one; a candidate
        that merely sounds better does not move.
      </p>

      <div className="notice">
        <strong>What this dataset can and cannot support.</strong> The golden set holds{' '}
        {runs[0]?.dataset_size ?? 0} labelled leads. That is enough to exercise the gate and
        to catch a gross regression. It is not enough for a confidence interval, and no
        statistical claim is made from it. The path to a meaningful dataset is in
        docs/EVALUATION.md; the case contract does not change along the way.
      </div>

      <h2>Rubric versions</h2>
      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th>Version</th><th>Status</th><th>Decisions citing it</th>
              <th>Published</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rubrics.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.version}</td>
                <td>
                  <span className={`pill ${r.status === 'published' ? 'ok' : r.status === 'draft' ? 'warn' : 'mute'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="mono">{r.decisions}</td>
                <td className="mono muted">
                  {r.published_at
                    ? new Date(r.published_at).toISOString().slice(0, 10)
                    : '—'}
                </td>
                <td className="muted">{r.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          A published definition is immutable and cannot be deleted while a decision cites
          it, so a receipt from last quarter still means what it said. Rollback archives the
          incumbent and publishes a prior version; it never edits one.
        </p>
      </div>

      <h2 style={{ marginTop: 24 }}>Runs</h2>
      {runs.length === 0 && (
        <div className="card"><p className="muted">No evaluation runs recorded.</p></div>
      )}
      {runs.map((run) => (
        <div className="card" key={run.id}>
          <div className="spread">
            <div className="row">
              <span className={`pill ${run.gate_decision === 'promote' ? 'ok' : run.gate_decision === 'reject' ? 'bad' : 'warn'}`}>
                gate: {run.gate_decision}
              </span>
              <strong className="mono">
                {run.production_version ?? '?'} vs {run.candidate_version ?? '?'}
              </strong>
            </div>
            <span className="mono muted" style={{ fontSize: 12 }}>
              {new Date(run.created_at).toISOString().slice(0, 16).replace('T', ' ')}
            </span>
          </div>

          <dl className="kv" style={{ margin: '10px 0 14px' }}>
            <dt>Dataset</dt>
            <dd className="mono">
              {run.dataset_version} · {run.dataset_size} cases
              {run.segment ? ` · segment ${run.segment}` : ''}
              {run.sample_seed ? ` · seed ${run.sample_seed}` : ''}
            </dd>
            {CONTEXT_METRICS.map((m) =>
              run.production_metrics?.[m.key] === undefined ? null : (
                <div key={m.key} style={{ display: 'contents' }}>
                  <dt>Counts</dt>
                  <dd className="mono">
                    production {run.production_metrics[m.key]} {m.label} · candidate{' '}
                    {run.candidate_metrics?.[m.key] ?? '—'} {m.label}
                  </dd>
                </div>
              ),
            )}
          </dl>

          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Production</th>
                  <th>Candidate</th>
                  <th>Delta</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => {
                  const prod = run.production_metrics?.[m.key];
                  const cand = run.candidate_metrics?.[m.key];
                  if (prod === undefined || cand === undefined) return null;
                  const delta = cand - prod;
                  const better = m.higherIsBetter ? delta > 0 : delta < 0;
                  const worse = m.higherIsBetter ? delta < 0 : delta > 0;
                  return (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      <td className="mono">{prod.toFixed(3)}</td>
                      <td className="mono">{cand.toFixed(3)}</td>
                      <td className="mono" style={{ color: worse ? 'var(--hot)' : better ? 'var(--ok)' : undefined }}>
                        {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginTop: 14 }}>Why the gate decided that</h3>
          <ul className="muted" style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            {run.gate_reasons.map((reason, i) => <li key={i}>{reason}</li>)}
          </ul>

          {run.gate_decision === 'promote' ? (
            <p className="muted" style={{ fontSize: 13 }}>
              The gate would allow promotion. Publishing is still a separate, human,
              admin-only action — the gate advises, it does not deploy.
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              Promotion is blocked. There is no override in the product; a candidate that
              regressed has to be changed and re-evaluated.
            </p>
          )}
        </div>
      ))}
    </>
  );
}
