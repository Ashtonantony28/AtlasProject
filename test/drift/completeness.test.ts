// SG12: drift has no false negatives from prompt caps, line endings, missing
// docs dirs, or deleted/added files — without new false positives.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closeDatabase, getAllFiles, openDatabase, type DB } from '../../src/core/db/index.js';
import { indexRepo } from '../../src/core/ingest/index.js';
import {
  createOfflineClient,
  exportDocs,
  MAX_MODULE_PROMPT_CHARS,
  modulePrompt,
  readPersistedDocs,
  synthesizeDocs,
} from '../../src/core/synth/index.js';
import { detectDrift } from '../../src/core/drift/index.js';
import { runCli } from '../cli/helpers.js';

const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newRepo(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'atlas-sg12-')), 'repo');
  dirs.push(dirname(root));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

async function documented(files: Record<string, string>): Promise<{ db: DB; root: string }> {
  const root = newRepo(files);
  const db = openDatabase(join(root, '..', 'index.db'));
  await indexRepo(db, root, { skipEmbeddings: true });
  await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 10_000_000 });
  exportDocs(db, join(root, '.atlas', 'docs'));
  return { db, root };
}

async function reindex(db: DB, root: string, mutate: (root: string) => void): Promise<void> {
  mutate(root);
  await indexRepo(db, root, { skipEmbeddings: true });
}

const stale = (db: DB, root: string, persisted = false): string[] =>
  detectDrift(db, {
    root,
    skipArchitecture: true,
    ...(persisted ? { docs: readPersistedDocs(join(root, '.atlas', 'docs')) } : {}),
  }).stale.map((s) => s.targetPath);

// `hub.ts::foo` is called by 25 files, well past the 12-call prompt cap.
function hubRepo(): Record<string, string> {
  const files: Record<string, string> = {
    'hub.ts':
      'export function foo(): number { return 1; }\nexport function bar(): number { return 2; }\n',
    'lone.ts': 'export function lone(): number { return 3; }\n',
  };
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, '0');
    files[`c${n}.ts`] =
      `import { foo, bar } from './hub';\nexport function c${n}(): number { return foo(); }\n`;
  }
  return files;
}

describe('neighbourhood hash', () => {
  it('a call edge beyond the cap marks the hub stale, in DB and persisted mode', async () => {
    const { db, root } = await documented(hubRepo());
    try {
      expect(stale(db, root)).toEqual([]);
      await reindex(db, root, (r) =>
        writeFileSync(
          join(r, 'c25.ts'),
          "import { foo, bar } from './hub';\nexport function c25(): number { return bar(); }\n",
        ),
      );
      expect(stale(db, root).sort()).toEqual(['c25.ts', 'hub.ts']);
      expect(stale(db, root, true).sort()).toEqual(['c25.ts', 'hub.ts']);
    } finally {
      closeDatabase(db);
    }
  });

  it('an edit that changes no edge, and an unrelated edit, mark only the edited files', async () => {
    const { db, root } = await documented(hubRepo());
    try {
      await reindex(db, root, (r) => {
        writeFileSync(join(r, 'c25.ts'), `${readFileSync(join(r, 'c25.ts'), 'utf8')}// note\n`);
        writeFileSync(join(r, 'lone.ts'), 'export function lone(): number { return 4; }\n');
      });
      expect(stale(db, root).sort()).toEqual(['c25.ts', 'lone.ts']);
      expect(stale(db, root, true).sort()).toEqual(['c25.ts', 'lone.ts']);
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps the prompt capped, with the digest in the header', async () => {
    const { db, root } = await documented(hubRepo());
    try {
      const hub = getAllFiles(db).find((f) => f.path === 'hub.ts')!;
      const prompt = modulePrompt(db, root, hub);
      expect(prompt.length).toBeLessThanOrEqual(MAX_MODULE_PROMPT_CHARS);
      expect(prompt.split('\n')[4]).toMatch(/^Neighbourhood hash: [0-9a-f]{64}$/);
      expect(prompt.match(/^ {2}- c\d\d\.ts#c\d\d -> foo$/gm)).toHaveLength(12);
    } finally {
      closeDatabase(db);
    }
  });

  it('lists the most strongly coupled files first, not just the alphabetically first', async () => {
    const files = hubRepo();
    files['zz.ts'] =
      "import { foo, bar } from './hub';\n" +
      'export function z1(): number { return foo(); }\n' +
      'export function z2(): number { return bar(); }\n';
    const { db, root } = await documented(files);
    try {
      const hub = getAllFiles(db).find((f) => f.path === 'hub.ts')!;
      const incoming = modulePrompt(db, root, hub).split('Incoming calls')[1] ?? '';
      expect(incoming.split('\n').slice(1, 3)).toEqual([
        '  - zz.ts#z1 -> foo',
        '  - zz.ts#z2 -> bar',
      ]);
    } finally {
      closeDatabase(db);
    }
  });
});

const SMALL = {
  'a.ts': 'export function foo(): number { return 1; }\n',
  'b.ts': "import { foo } from './a';\nexport function b(): number { return foo(); }\n",
  'c.py': 'def _private():\n    return 1\n',
};

describe('deleted and added files (DB mode)', () => {
  it('a deleted file stays stale until docs are regenerated', async () => {
    const { db, root } = await documented(SMALL);
    try {
      await reindex(db, root, (r) => rmSync(join(r, 'c.py')));
      const report = detectDrift(db, { root, skipArchitecture: true });
      expect(report.stale).toMatchObject([{ targetPath: 'c.py', currentHash: 'missing' }]);
      exportDocs(db, join(root, '.atlas', 'docs'));
      expect(existsSync(join(root, '.atlas', 'docs', 'files', 'c.py.md'))).toBe(false);
      await synthesizeDocs(db, createOfflineClient(), { root, tokenBudget: 1_000_000 });
      expect(detectDrift(db, { root }).hasDrift).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  it('a file deleted and restored unchanged is not stale', async () => {
    const { db, root } = await documented(SMALL);
    try {
      const text = readFileSync(join(root, 'c.py'), 'utf8');
      await reindex(db, root, (r) => rmSync(join(r, 'c.py')));
      await reindex(db, root, (r) => writeFileSync(join(r, 'c.py'), text));
      expect(detectDrift(db, { root }).hasDrift).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  it('an added file without exports is reported undocumented under --skip-architecture', async () => {
    const { db, root } = await documented(SMALL);
    try {
      await reindex(db, root, (r) =>
        writeFileSync(join(r, 'd.py'), 'def _helper():\n    return 2\n'),
      );
      const report = detectDrift(db, { root, skipArchitecture: true });
      expect(report.stale).toEqual([]);
      expect(report.undocumented).toEqual([
        { file: 'd.py', symbol: 'd.py', kind: 'module', startLine: 1 },
      ]);
      expect(report.hasDrift).toBe(true);
      expect(stale(db, root, true)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('persisted docs on disk', () => {
  it('reads CRLF docs exactly like LF docs', async () => {
    const { db, root } = await documented(SMALL);
    closeDatabase(db);
    const docsDir = join(root, '.atlas', 'docs');
    const lf = readPersistedDocs(docsDir);
    for (const rel of ['files/a.ts.md', 'files/b.ts.md', 'files/c.py.md', 'architecture.md']) {
      const p = join(docsDir, rel);
      writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(lf).toHaveLength(4);
    expect(readPersistedDocs(docsDir)).toEqual(lf);
  });

  it('`drift --docs-dir` exits 1 when the directory is missing or holds no docs', async () => {
    const root = newRepo(SMALL);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', root]);
    await runCli(['docs', '--offline', '--cwd', root]);
    const drift = async (dir: string): Promise<number> => {
      process.exitCode = undefined;
      await runCli(['drift', '--cwd', root, '--docs-dir', dir]);
      return Number(process.exitCode ?? 0);
    };

    expect(await drift('.atlas/docs')).toBe(0);
    expect(await drift('.atlas/no-such-dir')).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/docs directory not found/);
    mkdirSync(join(root, '.atlas', 'empty'));
    writeFileSync(join(root, '.atlas', 'empty', 'notes.md'), '# not a doc\n');
    expect(await drift('.atlas/empty')).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/no docs found/);
    writeFileSync(join(root, 'a.ts'), 'export function foo(): number { return 2; }\n');
    await runCli(['index', root]);
    expect(await drift('.atlas/docs')).toBe(2);
  });
});
