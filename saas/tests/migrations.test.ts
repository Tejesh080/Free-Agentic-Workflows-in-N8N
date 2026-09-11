import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, migrationFiles, seedTwoOrgs, type TestDb } from './helpers/pg';

describe('migrations', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });

  it('applies every migration in order', async () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
    const rows = await db.admin<{ c: number }>(
      `select count(*)::int as c from information_schema.tables where table_schema = 'public'`,
    );
    expect(rows[0]!.c).toBeGreaterThanOrEqual(13);
  });

  it('enables and forces RLS on every tenant-owned table', async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by relname`,
    );
    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    expect(unprotected.map((r) => r.relname)).toEqual([]);
  });

  it('seeds a two-organization fixture', async () => {
    const f = await seedTwoOrgs(db);
    expect(f.orgA).not.toEqual(f.orgB);
  });
});
