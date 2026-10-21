import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { makeGitRepo, runCli } from './helpers.js';

const answer = vi.hoisted(() => ({ text: null as string | null }));

vi.mock('../../src/core/synth/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/synth/index.js')>();
  return {
    ...real,
    createOfflineClient: () => {
      const offline = real.createOfflineClient();
      return {
        model: offline.model,
        complete: async (p: Parameters<typeof offline.complete>[0]) =>
          answer.text === null
            ? offline.complete(p)
            : { content: answer.text, inputTokens: 1, outputTokens: 1 },
      };
    },
  };
});

describe('atlas ask citation flags', () => {
  let dir: string;
  let out: string;
  beforeEach(async () => {
    dir = makeGitRepo('atlas-ask-');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(['index', dir]);
    vi.restoreAllMocks();
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out += String(s);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    answer.text = null;
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('--json includes checks and flagged citations', async () => {
    answer.text = 'See [1], [9] and src/nope.ts:3.';
    await runCli([
      'ask',
      'circle area',
      '-k',
      '3',
      '--expand',
      '2',
      '--offline',
      '--json',
      '--cwd',
      dir,
    ]);
    const json = JSON.parse(out) as {
      flagged: Array<{ raw: string; reason: string }>;
      checks: Array<{ raw: string; valid: boolean }>;
    };
    expect(json.checks.map((c) => c.raw)).toEqual(['[1]', '[9]', 'src/nope.ts:3']);
    expect(json.flagged).toEqual([
      expect.objectContaining({ raw: '[9]', reason: 'unknown-snippet' }),
      expect.objectContaining({ raw: 'src/nope.ts:3', reason: 'unknown-file' }),
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('human output lists unverified citations', async () => {
    answer.text = 'See [9].';
    await runCli(['ask', 'circle area', '-k', '3', '--expand', '2', '--offline', '--cwd', dir]);
    expect(out).toMatch(/Unverified citations:\n {2}\[9\] unknown-snippet/);
  });

  it('human output has no unverified section for the offline mock answer', async () => {
    await runCli(['ask', 'How is the area of a circle computed?', '--offline', '--cwd', dir]);
    expect(out).toMatch(/src\/shapes\.ts:\d+/);
    expect(out).not.toContain('Unverified citations');
  });
});
