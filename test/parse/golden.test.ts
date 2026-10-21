import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from '../../src/core/parse/index.js';
import { walkRepoReport } from '../../src/core/ingest/walker.js';

// Full parse output (symbols, imports, references, diagnostics) of every fixture file, pinned so
// walk and perf changes cannot alter extraction. Regenerate only for an intended output change:
//   ATLAS_UPDATE_GOLDEN=1 npx vitest run test/parse/golden.test.ts
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden.json');

async function parseFixtures(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const dir of ['sample', 'graph', 'parse']) {
    const { files } = walkRepoReport(join(ROOT, dir));
    for (const f of files) {
      const source = readFileSync(f.absolutePath, 'utf8');
      out[`${dir}/${f.relativePath}`] = await parseSource(source, f.language, f.relativePath);
    }
  }
  return out;
}

describe('parse golden output (fixtures/)', () => {
  it('matches test/parse/golden.json for every fixture file', async () => {
    const actual = await parseFixtures();
    if (process.env.ATLAS_UPDATE_GOLDEN === '1') {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    }
    const expected = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const path of Object.keys(expected)) expect(actual[path], path).toEqual(expected[path]);
  });
});
