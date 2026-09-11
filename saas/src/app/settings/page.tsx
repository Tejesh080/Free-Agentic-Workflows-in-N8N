import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

const ONBOARDING = [
  {
    title: 'Create the organization',
    detail: 'Done when you signed in. Everything below is scoped to it by the database.',
  },
  {
    title: 'Describe the ideal customer profile',
    detail: 'Signals, allowed values and weights. Declarative configuration, never uploaded logic.',
  },
  {
    title: 'Connect HubSpot',
    detail: 'Two write scopes. No read scope, so a leaked token cannot export your contacts.',
  },
  {
    title: 'Run ten leads in dry run',
    detail: 'Real qualification, real evidence, real score breakdown, and no CRM write.',
  },
  {
    title: 'Confirm or refine the rubric',
    detail: 'Change weights, re-run the same ten, compare. The gate stays in the way of promotion.',
  },
  {
    title: 'Set the approval policy',
    detail: 'What a run may do alone, and what stops for a human.',
  },
  {
    title: 'Raise the automation level',
    detail: 'Only now do real CRM writes happen. Until you change it, every run is a dry run.',
  },
];

export default async function SettingsPage() {
  const session = await requireSession();

  const { members, keys, integration, rubric, audit, automationLevel } = await withOrgContext(
    session.principal,
    async (tx) => ({
      members: await tx.query<{ email: string; display_name: string | null; role: string; created_at: Date }>(
        `select u.email, u.display_name, m.role::text as role, m.created_at
           from memberships m join users u on u.id = m.user_id
          order by m.created_at`,
      ),
      // Note the absent column: secret_hash is not selected here because the
      // application role has no privilege to read it.
      keys: await tx.query<{
        id: string; name: string; prefix: string; scopes: string[];
        created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
      }>(
        `select id, name, prefix, scopes, created_at, last_used_at, revoked_at
           from api_keys order by created_at desc`,
      ),
      integration: await tx.one<{
        provider: string; status: string; granted_scopes: string[];
        config: Record<string, unknown>; last_success_at: Date | null;
      }>(`select provider, status, granted_scopes, config, last_success_at from integrations limit 1`),
      rubric: await tx.one<{ version: string; definition: Record<string, unknown> }>(
        `select version, definition from rubric_versions where status = 'published' limit 1`,
      ),
      audit: await tx.query<{ action: string; target_type: string; created_at: Date; actor_type: string }>(
        `select action, target_type, created_at, actor_type from audit_events
          order by created_at desc limit 12`,
      ),
      automationLevel: (
        await tx.one<{ automation_level: string }>(`select automation_level from organizations limit 1`)
      )?.automation_level,
    }),
  );

  const isAdmin = ['owner', 'admin'].includes(session.principal.role);
  const signals = ((rubric?.definition?.['signals'] as unknown[]) ?? []) as {
    key: string; values: { value: string; points: number }[]; unsupported_penalty?: number;
  }[];

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        Organization, members, credentials, the CRM connection, and the scoring
        configuration every decision is reproducible against.
      </p>

      <div className="card">
        <h2>Getting to a real send</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          The order is deliberate: the product shows you what it does before it asks for
          permission to act. Nothing leaves the building until the last step.
        </p>
        <ol className="steps">
          {ONBOARDING.map((step, i) => (
            <li key={step.title} data-done={String(i < 2 || (i === 2 && integration?.status === 'connected'))}>
              <div>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Organization</h2>
          <dl className="kv">
            <dt>Name</dt><dd>{session.orgName}</dd>
            <dt>Slug</dt><dd className="mono">{session.orgSlug}</dd>
            <dt>Your role</dt><dd className="mono">{session.principal.role}</dd>
            <dt>Automation level</dt>
            <dd>
              <span className={`pill ${automationLevel === 'dry_run' ? 'mute' : 'warn'}`}>
                {automationLevel}
              </span>
            </dd>
          </dl>
          <p className="muted" style={{ fontSize: 12 }}>
            This is a ceiling, not a default. A caller asking for a live run on a{' '}
            <span className="mono">dry_run</span> organization gets a dry run. Only an owner
            or admin can raise it, and the database policy — not this page — is what enforces
            that.
          </p>
        </div>

        <div className="card">
          <h2>Members</h2>
          <table>
            <thead><tr><th>Member</th><th>Role</th><th>Joined</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email}>
                  <td>{m.display_name ?? m.email}<div className="muted" style={{ fontSize: 12 }}>{m.email}</div></td>
                  <td className="mono">{m.role}</td>
                  <td className="mono muted">{new Date(m.created_at).toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h2>API keys</h2>
          {isAdmin && <button className="btn" disabled title="Creation is wired in the API; the UI form is not built yet">Create key</button>}
        </div>
        {keys.length === 0 ? (
          <p className="muted">No keys.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Created</th><th>Last used</th><th>State</th></tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="mono">{k.prefix}…</td>
                    <td className="mono muted">{k.scopes.join(', ')}</td>
                    <td className="mono muted">{new Date(k.created_at).toISOString().slice(0, 10)}</td>
                    <td className="mono muted">
                      {k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 16).replace('T', ' ') : 'never'}
                    </td>
                    <td>
                      <span className={`pill ${k.revoked_at ? 'bad' : 'ok'}`}>
                        {k.revoked_at ? 'revoked' : 'active'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Only the prefix and a SHA-256 digest of the secret are stored. The full key is
          shown once, when it is created, and cannot be recovered afterwards — including by
          this page, which has no database privilege to read the digest column.
        </p>
      </div>

      <div className="card">
        <h2>HubSpot</h2>
        {integration ? (
          <>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <span className={`pill ${integration.status === 'connected' ? 'ok' : 'warn'}`}>
                  {integration.status}
                </span>
              </dd>
              <dt>API version</dt>
              <dd className="mono">{String(integration.config['api_version'] ?? '—')}</dd>
              <dt>Granted scopes</dt>
              <dd className="mono">{integration.granted_scopes.join(', ') || '—'}</dd>
              <dt>Deal stage</dt>
              <dd className="mono">{String(integration.config['deal_stage'] ?? '—')}</dd>
              <dt>Create follow-up task</dt>
              <dd className="mono">
                {String(integration.config['create_task'] ?? false)}
                {integration.config['create_task'] === false && (
                  <span className="muted"> — off, because enabling it costs a contact read scope</span>
                )}
              </dd>
              <dt>Last successful write</dt>
              <dd className="mono muted">
                {integration.last_success_at
                  ? new Date(integration.last_success_at).toISOString().slice(0, 16).replace('T', ' ')
                  : 'none yet'}
              </dd>
            </dl>
            {integration.status !== 'connected' && (
              <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
                Not connected. The credential lives in the execution engine&apos;s own
                credential store, never in this database — this row only records that it
                exists and what it is scoped to. See docs/HUBSPOT-SCOPES.md for the exact
                two scopes to grant and why nothing else is asked for.
              </div>
            )}
          </>
        ) : (
          <p className="muted">No integration configured.</p>
        )}
      </div>

      <div className="card">
        <div className="spread">
          <h2>Scoring rubric</h2>
          <span className="mono muted">{rubric?.version ?? 'none published'}</span>
        </div>
        {signals.length === 0 ? (
          <p className="muted">No published rubric.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Signal</th><th>Allowed values and weights</th><th>Unsupported penalty</th></tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.key}>
                    <td className="mono">{s.key}</td>
                    <td className="mono">
                      {s.values.map((v) => `${v.value} ${v.points > 0 ? '+' : ''}${v.points}`).join(' · ')}
                    </td>
                    <td className="mono" style={{ color: 'var(--hot)' }}>
                      {s.unsupported_penalty ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          The model picks one of the allowed values per signal and quotes the span it read
          it from. These weights turn those labels into a number. The model never returns a
          score, so there is nothing for it to inflate.
        </p>
      </div>

      <div className="card">
        <h2>Recent configuration changes</h2>
        <table>
          <thead><tr><th>Action</th><th>Target</th><th>Actor</th><th>When</th></tr></thead>
          <tbody>
            {audit.length === 0 && <tr><td colSpan={4} className="muted">Nothing recorded.</td></tr>}
            {audit.map((a, i) => (
              <tr key={i}>
                <td className="mono">{a.action}</td>
                <td className="mono muted">{a.target_type}</td>
                <td className="mono muted">{a.actor_type}</td>
                <td className="mono muted">
                  {new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          The audit log answers who changed the rules. It is append-only: the database
          refuses an update or a delete on this table.
        </p>
      </div>
    </>
  );
}
