// End-to-end simulation of the GitHub Action: index → drift → ci-comment.
// Asserts that the comment payload contains the drift the CI would post.
// This stands in for `act --dry-run`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { renderComment } from '../../src/cli/commands/ciCommentCmd.js';
import { insertMockDocs } from '../helpers/mockDocs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

describe('CI workflow end-to-end (index → drift → ci-comment)', () => {
  let dir: string;
  let workRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-ci-e2e-'));
    workRoot = join(dir, 'repo');
    cpSync(FIXTURE, workRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces the "all docs in sync" payload after a clean index + mock docs', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    insertMockDocs(db);

    const report = detectDrift(db);
    expect(report.hasDrift).toBe(false);

    const comment = renderComment(report);
    expect(comment).toMatch(/All docs are in sync/);
    expect(comment).toMatch(/4 files/);
    expect(comment).not.toMatch(/Stale docs/);
    expect(comment).not.toMatch(/Undocumented public symbols/);

    closeDatabase(db);
  });

  it('produces a stale-doc + undocumented payload after a fixture mutation', async () => {
    const db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, workRoot);
    insertMockDocs(db);

    const newFn = '\nexport function freshlyAdded(): number { return 42; }\n';
    const mathPath = join(workRoot, 'src/math.ts');
    writeFileSync(mathPath, readFileSync(mathPath, 'utf8') + newFn);
    await indexRepo(db, workRoot, { force: true });

    const report = detectDrift(db);
    expect(report.hasDrift).toBe(true);
    expect(report.stale.some((s) => s.targetPath === 'src/math.ts')).toBe(true);
    expect(report.undocumented.some((u) => u.symbol === 'freshlyAdded')).toBe(true);

    const comment = renderComment(report);
    expect(comment).toMatch(/Atlas — documentation report/);
    expect(comment).toMatch(/### Stale docs/);
    expect(comment).toMatch(/### Undocumented public symbols/);
    expect(comment).toMatch(/`src\/math\.ts`/);
    expect(comment).toMatch(/`freshlyAdded`/);
    expect(comment).toMatch(/\| Kind \| Symbol \| Location \|/);

    closeDatabase(db);
  });

  it('the workflow yaml chains index, drift, and ci-comment in order', async () => {
    const yml = readFileSync(
      new URL('../../.github/workflows/atlas.yml', import.meta.url),
      'utf8',
    );
    const indexIdx = yml.indexOf('index .');
    const driftIdx = yml.indexOf('drift --json');
    const ciCommentIdx = yml.indexOf('ci-comment');
    const postIdx = yml.indexOf('actions/github-script');
    expect(indexIdx).toBeGreaterThan(0);
    expect(driftIdx).toBeGreaterThan(indexIdx);
    expect(ciCommentIdx).toBeGreaterThan(driftIdx);
    expect(postIdx).toBeGreaterThan(ciCommentIdx);
  });
});
