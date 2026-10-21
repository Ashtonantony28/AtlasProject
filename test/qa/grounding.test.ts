import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearEdges,
  closeDatabase,
  findSymbolByName,
  insertEdges,
  openDatabase,
  type DB,
} from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  ask,
  checkCitations,
  retrieveForQuery,
  type Citation,
  type RetrievedSnippet,
} from '../../src/core/qa/index.js';
import type { LLMClient } from '../../src/core/synth/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'sample');

function fakeLLM(answer: (prompt: string) => string): LLMClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    model: 'fake',
    prompts,
    async complete(params) {
      const prompt = params.messages[params.messages.length - 1]?.content ?? '';
      prompts.push(prompt);
      return {
        content: answer(prompt),
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: 1,
      };
    },
  };
}

function writeRepo(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function longFunction(name: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `  const v${i} = ${i}; // line-${i}`);
  return [
    `export function ${name}(): number {`,
    ...body,
    `  return 0; // end-of-${name}`,
    '}',
    '',
  ].join('\n');
}

const CITES: Citation[] = [
  { index: 1, file: 'src/shapes.ts', startLine: 17, endLine: 26, symbol: 'Circle', kind: 'class' },
  { index: 2, file: 'src/math.ts', startLine: 4, endLine: 6, symbol: 'add', kind: 'function' },
];

describe('checkCitations', () => {
  it('accepts snippet refs and locations inside a retrieved span', () => {
    const checks = checkCitations(
      'Area is computed in [1] (src/shapes.ts:23) and add in src/math.ts:4-6 [2].',
      CITES,
    );
    expect(checks.map((c) => c.raw)).toEqual(['[1]', 'src/shapes.ts:23', 'src/math.ts:4-6', '[2]']);
    expect(checks.every((c) => c.valid)).toBe(true);
  });

  it('flags unknown snippet indexes, unknown files and out-of-span lines', () => {
    const checks = checkCitations(
      'See [9], [0], src/shapes.ts:40, src/math.ts:5-9, src/nope.ts:3 and [2].',
      CITES,
    );
    const flagged = checks.filter((c) => !c.valid);
    expect(flagged.map((c) => [c.raw, c.reason])).toEqual([
      ['[9]', 'unknown-snippet'],
      ['[0]', 'unknown-snippet'],
      ['src/shapes.ts:40', 'out-of-range'],
      ['src/math.ts:5-9', 'out-of-range'],
      ['src/nope.ts:3', 'unknown-file'],
    ]);
    expect(checks.find((c) => c.raw === '[2]')?.valid).toBe(true);
  });

  it('parses ranges, strips ./ and matches a path suffix of a retrieved file', () => {
    const checks = checkCitations(
      'In ./src/shapes.ts:17-26 and shapes.ts:20 and math.ts:99.',
      CITES,
    );
    expect(checks).toEqual([
      {
        raw: './src/shapes.ts:17-26',
        kind: 'location',
        index: null,
        file: 'src/shapes.ts',
        startLine: 17,
        endLine: 26,
        valid: true,
        reason: null,
      },
      expect.objectContaining({ raw: 'shapes.ts:20', file: 'src/shapes.ts', valid: true }),
      expect.objectContaining({ raw: 'math.ts:99', file: 'src/math.ts', reason: 'out-of-range' }),
    ]);
  });

  it('does not treat a suffix that is not a path segment as a known file', () => {
    const [check] = checkCitations('apes.ts:20', CITES);
    expect(check).toMatchObject({ valid: false, reason: 'unknown-file' });
  });

  it('dedupes repeated citations and ignores indexing, links and versions', () => {
    const checks = checkCitations(
      '[1] again [1]; arr[3] is code; [docs](http://x.io:8080/a) and node v1.2:3 are not citations.',
      CITES,
    );
    expect(checks.map((c) => c.raw)).toEqual(['[1]']);
  });

  it('flags an inverted range', () => {
    const [check] = checkCitations('src/shapes.ts:25-18', CITES);
    expect(check).toMatchObject({ valid: false, reason: 'out-of-range' });
  });

  it('returns no checks for an answer without citations', () => {
    expect(checkCitations('I cannot tell from the snippets.', CITES)).toEqual([]);
  });
});

describe('ask surfaces citation flags', () => {
  let dir: string;
  let db: DB;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-qa-g-'));
    db = openDatabase(join(dir, 'index.db'));
    await indexRepo(db, FIXTURE);
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a non-existent [9] and a file:line outside the spans, not a correct citation', async () => {
    const llm = fakeLLM((prompt) => {
      const m = prompt.match(/^\[1\] \w+: \S+ \(([^:]+):(\d+)-(\d+)\)$/m);
      if (!m) throw new Error('no snippet [1] in prompt');
      return `It is in ${m[1]}:${m[2]} [1]. Also see [9] and ${m[1]}:${Number(m[3]) + 500}.`;
    });
    const res = await ask(db, llm, FIXTURE, 'How is the area of a circle computed?', {
      seedLimit: 3,
      expansionLimit: 2,
    });
    expect(res.citations.length).toBeLessThan(9);
    expect(res.checks.length).toBe(4);
    expect(res.flagged.map((f) => f.reason)).toEqual(['unknown-snippet', 'out-of-range']);
    expect(res.flagged[0]?.raw).toBe('[9]');
    expect(res.flagged[1]?.raw).toMatch(/:\d+$/);
    expect(res.checks.filter((c) => c.valid).map((c) => c.kind)).toEqual(['location', 'snippet']);
  });

  it('flags nothing for the offline mock answer', async () => {
    const res = await ask(
      db,
      fakeLLM(() => 'No citations here.'),
      FIXTURE,
      'circle area',
    );
    expect(res.flagged).toEqual([]);
    const { createOfflineClient } = await import('../../src/core/synth/index.js');
    const off = await ask(
      db,
      createOfflineClient(),
      FIXTURE,
      'How is the area of a circle computed?',
    );
    expect(off.checks.length).toBeGreaterThan(0);
    expect(off.flagged).toEqual([]);
  });
});

describe('excerpts honour end_line', () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-qa-x-'));
    db = openDatabase(join(dir, 'index.db'));
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const only = (snips: RetrievedSnippet[], name: string): RetrievedSnippet => {
    const s = snips.find((x) => x.symbol.name === name);
    if (!s) throw new Error(`${name} not retrieved`);
    return s;
  };

  it('includes the full span of a symbol longer than 25 lines', async () => {
    writeRepo(dir, { 'src/long.ts': '// header\n' + longFunction('computeLongThing', 60) });
    await indexRepo(db, dir);
    const snips = await retrieveForQuery(db, dir, 'computeLongThing', { seedLimit: 1 });
    const s = only(snips, 'computeLongThing');
    expect(s.symbol.end_line - s.symbol.start_line).toBeGreaterThan(25);
    expect(s.startLine).toBe(s.symbol.start_line);
    expect(s.endLine).toBe(s.symbol.end_line);
    expect(s.truncated).toBe(false);
    expect(s.excerpt).toContain('line-59');
    expect(s.excerpt).toContain('end-of-computeLongThing');
    expect(s.excerpt.split('\n')).toHaveLength(s.endLine - s.startLine + 1);
  });

  it('does not run past end_line into the next symbol', async () => {
    writeRepo(dir, {
      'src/two.ts':
        'export function firstOne(): number {\n  return 1;\n}\n\nexport function secondOne(): number {\n  return 2;\n}\n',
    });
    await indexRepo(db, dir);
    const s = only(
      await retrieveForQuery(db, dir, 'firstOne', { seedLimit: 1, expansionLimit: 0 }),
      'firstOne',
    );
    expect(s.excerpt).toBe('export function firstOne(): number {\n  return 1;\n}');
    expect(s.endLine).toBe(3);
  });

  it('caps a huge symbol at the per-snippet limit and marks the truncation', async () => {
    writeRepo(dir, { 'src/huge.ts': longFunction('hugeGenerated', 1000) });
    await indexRepo(db, dir);
    const snips = await retrieveForQuery(db, dir, 'hugeGenerated', { seedLimit: 1 });
    const s = only(snips, 'hugeGenerated');
    expect(s.truncated).toBe(true);
    expect(s.endLine).toBe(s.startLine + 120 - 1);
    expect(s.excerpt).toContain('line-118');
    expect(s.excerpt).not.toMatch(/line-119$/m);
    expect(s.excerpt).not.toContain('end-of-hugeGenerated');
    expect(s.excerpt.split('\n').at(-1)).toMatch(/truncated: \d+ more lines through line 1003/);
  });

  it('respects an explicit excerptLines cap', async () => {
    writeRepo(dir, { 'src/long.ts': longFunction('computeLongThing', 60) });
    await indexRepo(db, dir);
    const s = only(
      await retrieveForQuery(db, dir, 'computeLongThing', { seedLimit: 1, excerptLines: 10 }),
      'computeLongThing',
    );
    expect(s.endLine).toBe(s.startLine + 9);
    expect(s.truncated).toBe(true);
  });

  it('keeps the ask prompt within budget when every snippet hits the cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/big${i}.ts`] = longFunction(`bigFn${i}`, 400);
    writeRepo(dir, files);
    await indexRepo(db, dir);
    const llm = fakeLLM(() => 'ok');
    const res = await ask(db, llm, dir, 'bigFn0 bigFn1 bigFn2', {
      seedLimit: 10,
      expansionLimit: 5,
    });
    expect(res.snippets.every((s) => s.truncated)).toBe(true);
    const promptLines = llm.prompts[0]?.split('\n').length ?? 0;
    expect(promptLines).toBeLessThanOrEqual(15 * (121 + 4) + 10);
    expect(res.inputTokens).toBeLessThan(40_000);
  });
});

describe('graph expansion ranks by edge strength', () => {
  let dir: string;
  let db: DB;
  const id = (name: string): number => {
    const s = findSymbolByName(db, name)[0];
    if (!s) throw new Error(`missing ${name}`);
    return s.id;
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-qa-e-'));
    db = openDatabase(join(dir, 'index.db'));
    writeRepo(dir, {
      'src/seed.ts': 'export function seedEntry(): number {\n  return 1;\n}\n',
      'src/a.ts': 'export function alphaHelper(): number {\n  return 2;\n}\n',
      'src/b.ts': 'export function betaHelper(): number {\n  return 3;\n}\n',
      'src/c.ts': 'export class GammaBase {}\n',
    });
    await indexRepo(db, dir);
    clearEdges(db);
  });
  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const expand = async (limit: number) =>
    (await retrieveForQuery(db, dir, 'seedEntry', { seedLimit: 1, expansionLimit: limit }))
      .filter((s) => s.reason === 'graph')
      .map((s) => s.symbol.name);

  it('prefers a resolved edge neighbor over a weak one when the limit allows one', async () => {
    insertEdges(db, [
      { src_symbol: id('seedEntry'), dst_symbol: id('alphaHelper'), kind: 'calls', weak: true },
      { src_symbol: id('seedEntry'), dst_symbol: id('betaHelper'), kind: 'calls', weak: false },
    ]);
    expect(await expand(1)).toEqual(['betaHelper']);
    expect(await expand(5)).toEqual(['betaHelper', 'alphaHelper']);
  });

  it('prefers stronger kinds, in either direction, deterministically', async () => {
    insertEdges(db, [
      {
        src_symbol: id('seedEntry'),
        dst_symbol: id('alphaHelper'),
        kind: 'references',
        weak: false,
      },
      { src_symbol: id('betaHelper'), dst_symbol: id('seedEntry'), kind: 'calls', weak: false },
      { src_symbol: id('seedEntry'), dst_symbol: id('GammaBase'), kind: 'extends', weak: false },
    ]);
    expect(await expand(1)).toEqual(['GammaBase']);
    expect(await expand(3)).toEqual(['GammaBase', 'betaHelper', 'alphaHelper']);
  });

  it('a weak strong-kind edge ranks below a resolved weaker-kind edge', async () => {
    insertEdges(db, [
      { src_symbol: id('seedEntry'), dst_symbol: id('GammaBase'), kind: 'extends', weak: true },
      {
        src_symbol: id('seedEntry'),
        dst_symbol: id('alphaHelper'),
        kind: 'references',
        weak: false,
      },
    ]);
    expect(await expand(1)).toEqual(['alphaHelper']);
  });

  it('keeps the best edge when a neighbor is reachable by several', async () => {
    insertEdges(db, [
      { src_symbol: id('seedEntry'), dst_symbol: id('alphaHelper'), kind: 'calls', weak: true },
      { src_symbol: id('seedEntry'), dst_symbol: id('betaHelper'), kind: 'calls', weak: false },
      { src_symbol: id('alphaHelper'), dst_symbol: id('seedEntry'), kind: 'extends', weak: false },
    ]);
    expect(await expand(5)).toEqual(['alphaHelper', 'betaHelper']);
  });

  it('respects a zero expansion limit and ignores dangling edges', async () => {
    insertEdges(db, [
      { src_symbol: id('seedEntry'), dst_symbol: null, kind: 'calls', weak: true },
      { src_symbol: id('seedEntry'), dst_symbol: id('betaHelper'), kind: 'calls', weak: false },
    ]);
    expect(await expand(0)).toEqual([]);
    expect(await expand(5)).toEqual(['betaHelper']);
  });
});
