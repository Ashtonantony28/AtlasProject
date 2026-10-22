import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EXTRACTOR_VERSION, parseSource } from '../../src/core/parse/index.js';
import { walkRepoReport } from '../../src/core/ingest/walker.js';

// Full parse output (symbols, imports, references, diagnostics) of every fixture file, pinned so
// walk and perf changes cannot alter extraction. Regenerate only for an intended output change:
//   ATLAS_UPDATE_GOLDEN=1 npx vitest run test/parse/golden.test.ts
// An output change must bump EXTRACTOR_VERSION (src/core/parse/version.ts) so existing indexes
// re-parse; golden.version.json records the version each golden.json was written with.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden.json');
const GOLDEN_VERSION = join(dirname(fileURLToPath(import.meta.url)), 'golden.version.json');

interface GoldenVersion {
  extractorVersion: number;
  sha256: string;
}

const digest = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

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
    const recorded = JSON.parse(readFileSync(GOLDEN_VERSION, 'utf8')) as GoldenVersion;
    if (process.env.ATLAS_UPDATE_GOLDEN === '1') {
      const { writeFileSync } = await import('node:fs');
      const sha256 = digest(readFileSync(GOLDEN, 'utf8'));
      if (sha256 !== recorded.sha256 && recorded.extractorVersion === EXTRACTOR_VERSION)
        throw new Error('parse output changed: bump EXTRACTOR_VERSION in src/core/parse/version.ts');
      const next: GoldenVersion = { extractorVersion: EXTRACTOR_VERSION, sha256 };
      writeFileSync(GOLDEN_VERSION, `${JSON.stringify(next, null, 1)}\n`);
      Object.assign(recorded, next);
    }
    expect(recorded.extractorVersion, 'regenerate the golden after bumping EXTRACTOR_VERSION').toBe(
      EXTRACTOR_VERSION,
    );
    expect(recorded.sha256, 'golden.json changed without ATLAS_UPDATE_GOLDEN=1').toBe(
      digest(readFileSync(GOLDEN, 'utf8')),
    );
    const expected = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const path of Object.keys(expected)) expect(actual[path], path).toEqual(expected[path]);
  });
});
