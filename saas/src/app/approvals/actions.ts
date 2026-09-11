'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/server-session';
import { withOrgContext } from '@/lib/db/client';
import { decideApproval } from '@/lib/approvals/decide';

/**
 * Deciding an approval from the dashboard.
 *
 * The approval id arrives from a form, so it is caller-influenced — which is
 * fine, because it is only ever used inside an organization-scoped session. The
 * policy on approval_requests means an id belonging to another organization
 * resolves to nothing, so this action cannot be aimed at somebody else's queue.
 */
export async function decide(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('approval_id') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const note = String(formData.get('note') ?? '').slice(0, 2000) || undefined;

  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('decision must be approved or rejected');
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('malformed approval id');
  }

  await withOrgContext(session.principal, (tx) =>
    decideApproval(tx, session.principal, id, decision, note),
  );

  revalidatePath('/approvals');
  revalidatePath('/');
}
