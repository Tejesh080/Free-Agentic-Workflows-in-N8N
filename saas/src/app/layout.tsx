import type { Metadata } from 'next';
import './globals.css';
import { getSession } from '@/lib/auth/server-session';

export const metadata: Metadata = {
  title: 'Revenue Swarm',
  description: 'Auditable AI revenue operations: evidence-grounded qualification, deterministic scoring, governed actions.',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/leads', label: 'Leads' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/evaluations', label: 'Evaluations' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <strong>Revenue Swarm</strong>
              <span>Auditable revenue operations</span>
            </div>
            <nav className="nav">
              {NAV.map((item) => (
                <a key={item.href} href={item.href}>{item.label}</a>
              ))}
            </nav>
            {session ? (
              <div className="org">
                <strong>{session.orgName}</strong>
                <span>{session.email} · {session.principal.role}</span>
                <div style={{ marginTop: 6 }}>
                  <span className="pill mute">automation: {session.automationLevel}</span>
                </div>
              </div>
            ) : (
              <div className="org"><strong>No session</strong><span>sign in to continue</span></div>
            )}
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
