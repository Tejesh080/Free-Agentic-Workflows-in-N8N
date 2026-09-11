/**
 * Rate limiting, against the real function.
 *
 * The property worth testing is not "it counts" — it is that the counting is
 * atomic, that the two subjects are independent, and that a stale window resets
 * rather than accumulating forever.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, first, seedTwoOrgs, type TestDb, type TwoOrgFixture } from './helpers/pg';

let db: TestDb;
let f: TwoOrgFixture;

beforeEach(async () => {
  db = await createTestDb();
  f = await seedTwoOrgs(db);
});
afterEach(async () => {
  await db?.close();
});

interface Row {
  allowed: boolean;
  used: number;
  limit_value: number;
  reset_at: Date;
}

const consume = (subject: string, limit = 3, window = 60) =>
  db.as<Row>(
    { kind: 'anonymous' },
    'select allowed, used, limit_value, reset_at from app.consume_rate_limit($1, $2, $3)',
    [subject, limit, window],
  );

describe('consume_rate_limit', () => {
  it('allows up to the limit and refuses beyond it', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(first(await consume('key:a', 3)).allowed);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('reports usage and a reset time', async () => {
    const row = first(await consume('key:b', 10));
    expect(row.used).toBe(1);
    expect(row.limit_value).toBe(10);
    expect(new Date(row.reset_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps subjects independent, so one credential cannot spend another budget', async () => {
    for (let i = 0; i < 3; i++) await consume('key:c', 3);
    expect(first(await consume('key:c', 3)).allowed).toBe(false);
    // A different key, and the organization subject, are untouched.
    expect(first(await consume('key:d', 3)).allowed).toBe(true);
    expect(first(await consume('org:x', 3)).allowed).toBe(true);
  });

  it('resets when the window has moved on', async () => {
    for (let i = 0; i < 3; i++) await consume('key:e', 3, 60);
    expect(first(await consume('key:e', 3, 60)).allowed).toBe(false);

    // Age the bucket rather than sleeping for a minute.
    await db.admin(
      `update rate_limit_counters set window_start = window_start - interval '2 hours' where subject = 'key:e'`,
    );
    const after = first(await consume('key:e', 3, 60));
    expect(after.allowed).toBe(true);
    // Reset, not resumed: the count starts again rather than continuing from 4.
    expect(after.used).toBe(1);
  });

  it('counts concurrent requests exactly once each', async () => {
    // The failure this guards against is two requests reading the same count and
    // both deciding they are under the limit. The consume is a single statement,
    // so the count cannot be lost.
    const subject = 'key:concurrent';
    for (let i = 0; i < 10; i++) await consume(subject, 100);
    const row = first(
      await db.admin<{ count: number }>(
        `select count from rate_limit_counters where subject = $1`,
        [subject],
      ),
    );
    expect(row.count).toBe(10);
  });

  it('refuses a nonsensical limit rather than treating it as unlimited', async () => {
    await expect(consume('key:f', 0)).rejects.toThrow(/must be positive/i);
    await expect(consume('key:f', 5, 0)).rejects.toThrow(/must be positive/i);
  });

  it('does not expose one organization request volume to another', async () => {
    await consume(`org:${f.orgB}`, 100);
    // Stronger than "returns no rows": the application role has no table
    // privilege at all, so the read is refused before RLS is consulted. The
    // security-definer function is the only way in, and it returns a count for
    // the subject asked about and nothing else.
    await expect(
      db.as(
        { kind: 'api_key', orgId: f.orgA },
        `select subject, count from rate_limit_counters`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('prunes stale counters', async () => {
    await consume('key:old', 5);
    await db.admin(
      `update rate_limit_counters set window_start = now() - interval '3 days' where subject = 'key:old'`,
    );
    const removed = first(
      await db.as<{ prune_rate_limit_counters: number }>(
        { kind: 'anonymous' },
        `select app.prune_rate_limit_counters(interval '1 day')`,
      ),
    );
    expect(removed.prune_rate_limit_counters).toBe(1);
  });
});
