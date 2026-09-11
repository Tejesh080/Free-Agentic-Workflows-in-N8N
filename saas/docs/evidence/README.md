# Evidence

Rendered output captured from the running application on 2026-09-12, against the
seeded two-organization local database (`npx tsx scripts/seed-demo.ts`).

Text rather than screenshots, deliberately: the point of each file is what the
screen *said*, and text diffs when a regression changes it.

| File | What it proves |
| --- | --- |
| `overview.txt` | Seven leads, not eight. The second organization's lead exists in the database and does not appear. |
| `lead-detail-unsupported.txt` | A model-supplied quote that is absent from the source text earns `-10` instead of `+25`. |
| `lead-detail-xss.txt` | A `<script>` tag and an `onerror` attribute arrive in evidence and render as inert text. |
| `approvals-before.txt` / `approvals-after.txt` | The approval state machine, driven through the real UI: pending → approved, attributed, and still not executed. |
| `evaluations.txt` | The candidate rubric regressed on three metrics, improved on none, and the gate rejected it. |
| `settings.txt` | Scopes, automation ceiling, rubric weights, and the append-only audit log. |

## How to reproduce

```bash
cd saas
npm install
npx tsx scripts/seed-demo.ts
npm run dev
```

No Docker, no Supabase project and no connection string: `DATABASE_URL=pglite://.pglite`
runs the same migrations, the same `revenue_swarm_app` role and the same policies
against Postgres compiled to WebAssembly.
