// AUDIT-2 A2-01: the per-module call-edge queries in synth/context.ts drive from
// idx_edges_kind (every `calls` edge in the repo) instead of the file's symbols,
// so docs and drift are O(files x edges). Marked `fails` until fixed: when the
// plan stops scanning idx_edges_kind this test starts failing and should become a
// plain `it`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getAllFiles, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildModuleContext } from '../../src/core/synth/index.js';

describe('AUDIT-2 query plans', () => {
  let dir: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-audit2-'));
    const root = join(dir, 'repo');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'export function a(): number {\n  return 1;\n}\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import { a } from './a';\nexport function b(): number {\n  return a();\n}\n",
    );
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it.fails('module call-edge queries do not scan every call edge (A2-01)', () => {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = ((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    db.prepare = spy;
    const file = getAllFiles(db).find((f) => f.path === 'b.ts')!;
    buildModuleContext(db, join(dir, 'repo'), file);
    db.prepare = prepare;
    const callSql = seen.filter((s) => /JOIN edges/.test(s));
    expect(callSql.length).toBeGreaterThan(0);
    for (const sql of callSql) {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(file.id) as { detail: string }[])
        .map((r) => r.detail)
        .join('\n');
      expect(plan).not.toMatch(/idx_edges_kind/);
    }
  });
});
