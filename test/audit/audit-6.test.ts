// AUDIT-6: performance under load (round 2). Each `it.fails` asserts the CORRECT (bounded)
// behaviour and currently fails, reproducing one finding in AUDIT-6.md (IDs A6-xx). When a
// finding is fixed its test starts passing, `it.fails` turns red, and it should become a plain
// `it`. Heavy measurements live in scripts/audit2-*.mjs; these tests count work, not time.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, counts, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { buildGraphJson } from '../../src/core/graph/index.js';
import {
  createOfflineClient,
  exportDocs,
  findDoc,
  synthesizeDocs,
} from '../../src/core/synth/index.js';

// Counts reads of persisted doc files (`.md`), off unless a test sets `fsCount.on`.
const fsCount = vi.hoisted(() => ({ on: false, mdReads: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
    if (fsCount.on && String(path).endsWith('.md')) fsCount.mdReads++;
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const FILES = 40;

/** A repo where every file calls the previous file's export, so edges span the graph. */
function writeRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const body =
      i === 0
        ? 'export function f0(): number {\n  return 0;\n}\n'
        : `import { f${i - 1} } from './m${i - 1}';\n/** Step ${i}. */\nexport function f${i}(): number {\n  return f${i - 1}() + 1;\n}\nexport function g${i}(): number {\n  return f${i}();\n}\n`;
    writeFileSync(join(root, 'src', `m${i}.ts`), body);
  }
}

/** Rows that `.all()` returned from statements reading `edges`, while `fn` runs. */
function edgeRowsRead(db: DB, fn: () => void): number {
  let rows = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (!/\bFROM edges\b/.test(sql)) return stmt;
    const all = stmt.all.bind(stmt);
    stmt.all = ((...a: unknown[]) => {
      const out = all(...(a as []));
      rows += Array.isArray(out) ? out.length : 0;
      return out;
    }) as typeof stmt.all;
    return stmt;
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return rows;
}

describe('AUDIT-6 performance under load', () => {
  let dir: string;
  let root: string;
  let db: DB;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-audit6-'));
    root = join(dir, 'repo');
    writeRepo(root);
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, root, { skipEmbeddings: true });
  });
  afterAll(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it.fails('A6-01: a one-node page of a broad `file` scope does not read every edge', () => {
    const total = counts(db).edges;
    expect(total).toBeGreaterThan(2 * FILES);
    let page: ReturnType<typeof buildGraphJson> | undefined;
    const rows = edgeRowsRead(db, () => {
      page = buildGraphJson(db, { file: 'src', limit: 1, edgeLimit: 1 });
    });
    expect(page?.nodes.length).toBe(1);
    // The page touches one node; `totals.edges` can be counted in SQL.
    expect(rows).toBeLessThan(total / 2);
  });

  it.fails('A6-02: looking up one persisted doc does not read every persisted doc', async () => {
    const docsDir = join(dir, 'docs');
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 10_000_000 });
    const { total } = exportDocs(db, docsDir);
    expect(total).toBeGreaterThan(FILES);
    fsCount.mdReads = 0;
    fsCount.on = true;
    try {
      const doc = findDoc(db, docsDir, 'src/m7.ts');
      expect(doc.target).toBe('src/m7.ts');
    } finally {
      fsCount.on = false;
    }
    expect(fsCount.mdReads).toBeLessThanOrEqual(1);
  });
});
