// Generates a synthetic TypeScript repo: `files * perFile` near-identical
// "widget" functions, plus a few interfaces under src/special/ and one oddly
// named function (`zxqv`) whose text shares nothing with the rest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeSyntheticRepo(dir, { files = 200, perFile = 50 } = {}) {
  mkdirSync(join(dir, 'src', 'widgets'), { recursive: true });
  mkdirSync(join(dir, 'src', 'special'), { recursive: true });
  for (let i = 0; i < files; i++) {
    const fns = [];
    for (let j = 0; j < perFile; j++) {
      fns.push(
        `/** Compute the widget total for batch ${i}. */\n` +
          `export function widgetTotal${i}x${j}(count: number): number {\n` +
          `  return count * ${j} + ${i};\n}\n`,
      );
    }
    writeFileSync(join(dir, 'src', 'widgets', `mod${i}.ts`), fns.join('\n'));
  }
  const ifaces = [0, 1, 2].map(
    (k) => `/** Pane options for a widget. */\nexport interface PaneLayout${k} {\n  columns: number;\n}\n`,
  );
  writeFileSync(join(dir, 'src', 'special', 'layout.ts'), ifaces.join('\n'));
  writeFileSync(
    join(dir, 'src', 'special', 'odd.ts'),
    'export function zxqv(stream: string[]): number {\n  return stream.length;\n}\n',
  );
}
