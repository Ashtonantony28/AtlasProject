import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProgram } from '../../src/cli/program.js';

export const SAMPLE = resolve(__dirname, '../../fixtures/sample');

export function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(SAMPLE, 'src'), join(dir, 'src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export function gitStatus(dir: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

export async function runCli(args: string[]): Promise<void> {
  const program = buildProgram().exitOverride();
  await program.parseAsync(['node', 'atlas', ...args]);
}
