// A synthetic indexed repo larger than the default graph and drift limits
// (SG15): FILES files of FNS exported functions, each calling the previous one.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { createOfflineClient, exportDocs, synthesizeDocs } from '../../src/core/synth/index.js';

export const FILES = 120;
export const FNS = 10;

export function writeBigRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const fns = Array.from({ length: FNS }, (_, k) =>
      k === 0
        ? `export function f${i}_0(x: number): number {\n  return x;\n}\n`
        : `export function f${i}_${k}(x: number): number {\n  return f${i}_${k - 1}(x) + 1;\n}\n`,
    );
    writeFileSync(join(root, 'src', `m${i}.ts`), fns.join('\n'));
  }
}

/**
 * Index, generate offline docs (also into `.atlas/docs`), then make every doc
 * stale and empty so drift reports FILES stale docs and FILES * FNS undocumented symbols.
 */
export async function indexBigRepo(root: string): Promise<void> {
  writeBigRepo(root);
  const db = openDatabase(join(root, '.atlas', 'index.db'));
  try {
    await indexRepo(db, root);
    await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 10_000_000 });
    exportDocs(db, join(root, '.atlas', 'docs'));
    db.prepare("UPDATE docs SET source_hash = 'stale', content = '# doc'").run();
  } finally {
    closeDatabase(db);
  }
}
