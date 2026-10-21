import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DriftReport } from '../../core/drift/index.js';

interface CiCommentArgs {
  in: string;
  out?: string;
}

export function registerCiCommentCommand(program: Command): void {
  program
    .command('ci-comment')
    .description('Render a PR comment in Markdown from a drift JSON report.')
    .requiredOption('--in <path>', 'Path to drift JSON (from `atlas drift --json`)')
    .option('--out <path>', 'Write to file instead of stdout')
    .action((opts: CiCommentArgs) => {
      const reportPath = resolve(opts.in);
      const raw = readFileSync(reportPath, 'utf8');
      const report = JSON.parse(raw) as DriftReport;
      const body = renderComment(report);
      if (opts.out) {
        writeFileSync(resolve(opts.out), body, 'utf8');
        process.stdout.write(`wrote ${opts.out} (${body.length} chars)\n`);
      } else {
        process.stdout.write(body);
      }
    });
}

export function renderComment(report: DriftReport): string {
  const lines: string[] = [];
  lines.push('## Atlas — documentation report');
  lines.push('');
  lines.push(
    `**Totals:** ${report.totals.files} files · ${report.totals.docs} docs · ${report.totals.publicSymbols} public symbols`,
  );
  lines.push('');
  if (!report.hasDrift) {
    lines.push('**Drift check: passed.** All docs are in sync and every public symbol is documented.');
    return lines.join('\n') + '\n';
  }
  if (report.failing) {
    const why: string[] = [];
    if (report.stale.length > 0) why.push(`${report.stale.length} stale doc(s)`);
    if (report.strict && report.undocumented.length > 0) {
      why.push(`${report.undocumented.length} undocumented public symbol(s) (--strict)`);
    }
    lines.push(`**Drift check: failed** (${why.join(', ')}).`);
  } else {
    lines.push(
      '**Drift check: passed.** No stale docs; the undocumented public symbols below are informational (they fail the check only with `--strict`).',
    );
  }
  lines.push('');

  if (report.stale.length > 0) {
    lines.push(`### Stale docs (${report.stale.length})`);
    lines.push('');
    lines.push('| Kind | Target | Stored hash | Current hash |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of report.stale) {
      lines.push(
        `| ${s.kind} | \`${s.targetPath}\` | \`${s.storedHash.slice(0, 8)}\` | \`${s.currentHash.slice(0, 8)}\` |`,
      );
    }
    lines.push('');
  }

  if (report.undocumented.length > 0) {
    const shown = report.undocumented.slice(0, 30);
    lines.push(
      `### Undocumented public symbols (${report.undocumented.length} of ${report.totals.publicSymbols})`,
    );
    lines.push('');
    lines.push('| Kind | Symbol | Location |');
    lines.push('| --- | --- | --- |');
    for (const u of shown) {
      lines.push(`| ${u.kind} | \`${u.symbol}\` | \`${u.file}:${u.startLine}\` |`);
    }
    if (report.undocumented.length > shown.length) {
      lines.push('');
      lines.push(`…and ${report.undocumented.length - shown.length} more.`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_Fix with `atlas docs` (or update the affected docs by hand)._');
  return lines.join('\n') + '\n';
}
