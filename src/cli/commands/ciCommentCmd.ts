import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
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
      const body = renderComment(parseDriftReport(readFileSync(reportPath, 'utf8')));
      if (opts.out) {
        writeFileSync(resolve(opts.out), body, 'utf8');
        process.stdout.write(`wrote ${opts.out} (${body.length} chars)\n`);
      } else {
        process.stdout.write(body);
      }
    });
}

const count = z.number().int().nonnegative();
const ReportSchema = z.object({
  stale: z.array(
    z.object({
      kind: z.enum(['file', 'architecture']),
      targetId: z.number(),
      targetPath: z.string(),
      storedHash: z.string(),
      currentHash: z.string(),
    }),
  ),
  undocumented: z.array(
    z.object({ file: z.string(), symbol: z.string(), kind: z.string(), startLine: z.number() }),
  ),
  totals: z.object({
    files: count,
    docs: count,
    publicSymbols: count,
    stale: count.optional(),
    undocumented: count.optional(),
  }),
  hasDrift: z.boolean().optional(),
  failing: z.boolean().optional(),
  strict: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

/**
 * Validate `atlas drift --json` output. Reports from before paging (no `totals.stale`,
 * `failing`, …) were complete, so the missing fields are derived from the lists.
 */
export function parseDriftReport(raw: string): DriftReport {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`drift report is not JSON: ${(err as Error).message}`);
  }
  const r = ReportSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(
      `not a drift report (from \`atlas drift --json\`): ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const { stale, undocumented, totals } = r.data;
  const strict = r.data.strict ?? false;
  const staleTotal = totals.stale ?? stale.length;
  const undocTotal = totals.undocumented ?? undocumented.length;
  return {
    stale,
    undocumented,
    totals: { ...totals, stale: staleTotal, undocumented: undocTotal },
    hasDrift: r.data.hasDrift ?? staleTotal + undocTotal > 0,
    failing: r.data.failing ?? (staleTotal > 0 || (strict && undocTotal > 0)),
    strict,
    truncated: r.data.truncated ?? (stale.length < staleTotal || undocumented.length < undocTotal),
  };
}

const shown = (listed: number, total: number): string =>
  listed < total ? `, showing ${listed}` : '';

export function renderComment(report: DriftReport): string {
  const { totals } = report;
  const lines: string[] = [];
  lines.push('## Atlas — documentation report');
  lines.push('');
  lines.push(
    `**Totals:** ${totals.files} files · ${totals.docs} docs · ${totals.publicSymbols} public symbols`,
  );
  lines.push('');
  if (!report.hasDrift) {
    lines.push(
      '**Drift check: passed.** All docs are in sync and every public symbol is documented.',
    );
    return lines.join('\n') + '\n';
  }
  if (report.failing) {
    const why: string[] = [];
    if (totals.stale > 0) why.push(`${totals.stale} stale doc(s)`);
    if (report.strict && totals.undocumented > 0) {
      why.push(`${totals.undocumented} undocumented public symbol(s) (--strict)`);
    }
    lines.push(`**Drift check: failed** (${why.join(', ')}).`);
  } else {
    lines.push(
      '**Drift check: passed.** No stale docs; the undocumented public symbols below are informational (they fail the check only with `--strict`).',
    );
  }
  lines.push('');
  if (report.truncated) {
    lines.push(
      `> This report is one page of the drift check (${report.stale.length} of ${totals.stale} stale docs, ${report.undocumented.length} of ${totals.undocumented} undocumented symbols listed). Run \`atlas drift\` without \`--limit\`/\`--offset\` for the full list.`,
    );
    lines.push('');
  }

  if (totals.stale > 0) {
    lines.push(`### Stale docs (${totals.stale}${shown(report.stale.length, totals.stale)})`);
    lines.push('');
  }
  if (report.stale.length > 0) {
    lines.push('| Kind | Target | Stored hash | Current hash |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of report.stale) {
      lines.push(
        `| ${s.kind} | \`${s.targetPath}\` | \`${s.storedHash.slice(0, 8)}\` | \`${s.currentHash.slice(0, 8)}\` |`,
      );
    }
    lines.push('');
  }

  if (totals.undocumented > 0) {
    const rows = report.undocumented.slice(0, 30);
    lines.push(
      `### Undocumented public symbols (${totals.undocumented} of ${totals.publicSymbols}${shown(rows.length, totals.undocumented)})`,
    );
    lines.push('');
    if (rows.length > 0) {
      lines.push('| Kind | Symbol | Location |');
      lines.push('| --- | --- | --- |');
      for (const u of rows) {
        lines.push(`| ${u.kind} | \`${u.symbol}\` | \`${u.file}:${u.startLine}\` |`);
      }
      lines.push('');
    }
    if (totals.undocumented > rows.length) {
      lines.push(`…and ${totals.undocumented - rows.length} more.`, '');
    }
  }

  lines.push('---');
  lines.push('_Fix with `atlas docs` (or update the affected docs by hand)._');
  return lines.join('\n') + '\n';
}
