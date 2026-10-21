// Realistic-shape synthetic repo for perf audits (AUDIT-2): mixed TS / JS / Python
// in packages of 20 files, each file importing 2-4 earlier files and calling
// their exports, classes extending imported classes, `this.` method calls and
// docstrings. Deterministic for a given file count.
//   node scripts/audit-repo.mjs <dir> <files>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PER_PKG = 20;
const WORDS = [
  'order', 'invoice', 'customer', 'ledger', 'payment', 'session', 'token', 'cache',
  'report', 'metric', 'queue', 'worker', 'schedule', 'account', 'profile', 'address',
  'shipment', 'catalog', 'price', 'discount', 'audit', 'event', 'stream', 'buffer',
];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function langOf(i) {
  const m = i % 4;
  return m < 2 ? 'ts' : m === 2 ? 'js' : 'py';
}

function fileInfo(i) {
  const lang = langOf(i);
  const pkg = Math.floor(i / PER_PKG);
  const w = WORDS[i % WORDS.length];
  const base = `${w}${i}`;
  const fns = [0, 1, 2, 3, 4, 5].map((k) => `${lang === 'py' ? 'handle' : 'handle'}${cap(w)}${i}x${k}`);
  return { i, lang, pkg, w, base, fns, cls: `${cap(w)}Service${i}` };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

function relPath(info) {
  const ext = info.lang === 'py' ? 'py' : info.lang;
  const dir = info.lang === 'py' ? `py/pkg${info.pkg}` : `src/pkg${info.pkg}`;
  return `${dir}/${info.base}.${ext}`;
}

function relSpec(from, to) {
  // TS/JS relative specifier from file `from` to file `to`.
  const same = from.pkg === to.pkg;
  return `${same ? '.' : `../pkg${to.pkg}`}/${to.base}${to.lang === 'js' ? '.js' : ''}`;
}

function pickDeps(i, rand, files) {
  // Earlier files of the same language family (TS/JS share imports; Python only Python).
  const py = langOf(i) === 'py';
  const deps = [];
  const want = 2 + Math.floor(rand() * 3);
  for (let tries = 0; deps.length < want && tries < 40; tries++) {
    const back = 1 + Math.floor(rand() * Math.min(i, 60));
    const j = i - back;
    if (j < 0) break;
    if ((langOf(j) === 'py') !== py) continue;
    if (!deps.includes(j)) deps.push(j);
  }
  return deps.map((j) => files[j]);
}

function tsFile(info, deps, rand) {
  const L = [];
  L.push(`// ${info.w} module ${info.i}`);
  for (const d of deps) {
    if (info.lang === 'js' && rand() < 0.3) {
      L.push(`const { ${d.fns[0]} } = require('${relSpec(info, d)}');`);
    } else {
      L.push(`import { ${d.fns[0]}, ${d.fns[1]}, ${d.cls} } from '${relSpec(info, d)}';`);
    }
  }
  L.push('');
  const ts = info.lang === 'ts';
  const t = (s) => (ts ? s : '');
  if (ts) {
    L.push(`/** Options for the ${info.w} pipeline. */`);
    L.push(`export interface ${cap(info.w)}Options${info.i} {\n  limit: number;\n  label?: string;\n}`);
    L.push(`export type ${cap(info.w)}Id${info.i} = string;`);
    L.push('');
  }
  info.fns.forEach((fn, k) => {
    L.push(`/**\n * Process a ${info.w} batch (step ${k}).\n * Returns the adjusted ${WORDS[(info.i + k) % WORDS.length]} count.\n */`);
    L.push(`export function ${fn}(input${t(': number')}, opts${t('?: { scale?: number }')})${t(': number')} {`);
    L.push(`  const scale = opts?.scale ?? ${k + 1};`);
    L.push(`  let total = input * scale;`);
    if (k > 0) L.push(`  total += ${info.fns[k - 1]}(input - 1);`);
    const d = deps[k % Math.max(1, deps.length)];
    if (d && k < 3) L.push(`  total += ${d.fns[0]}(total % 7);`);
    L.push(`  for (let i = 0; i < 3; i++) {\n    total = Math.max(0, total - i);\n  }`);
    L.push(`  return total;\n}`);
    L.push('');
  });
  const parent = deps.find((d) => d.lang !== 'py');
  const ext = parent && rand() < 0.5 ? ` extends ${parent.cls}` : '';
  L.push(`/** Coordinates ${info.w} work for package ${info.pkg}. */`);
  L.push(`export class ${info.cls}${ext} {`);
  if (ts) L.push(`  private count = 0;`);
  for (let m = 0; m < 4; m++) {
    L.push(`  /** Step ${m} of the ${info.w} flow. */`);
    L.push(`  step${m}(value${t(': number')})${t(': number')} {`);
    L.push(m > 0 ? `    const prev = this.step${m - 1}(value);` : `    const prev = ${info.fns[0]}(value);`);
    L.push(`    return prev + ${m};\n  }`);
  }
  L.push(`}`);
  L.push('');
  L.push(`function internal${info.i}(xs${t(': number[]')})${t(': number')} {\n  return xs.reduce((a, b) => a + ${info.fns[2]}(b), 0);\n}`);
  L.push(`export const ${info.w}Default${info.i} = internal${info.i}([1, 2, 3]);`);
  return L.join('\n') + '\n';
}

function pyFile(info, deps, rand) {
  const L = [];
  L.push(`"""${cap(info.w)} module ${info.i}."""`);
  for (const d of deps) {
    if (d.pkg === info.pkg) L.push(`from .${d.base} import ${d.fns[0]}, ${d.fns[1]}, ${d.cls}`);
    else L.push(`from py.pkg${d.pkg}.${d.base} import ${d.fns[0]}, ${d.fns[1]}, ${d.cls}`);
  }
  L.push('');
  info.fns.forEach((fn, k) => {
    L.push(`def ${fn}(value, scale=${k + 1}):`);
    L.push(`    """Process a ${info.w} batch (step ${k}); returns the adjusted ${WORDS[(info.i + k) % WORDS.length]} count."""`);
    L.push(`    total = value * scale`);
    if (k > 0) L.push(`    total += ${info.fns[k - 1]}(value - 1)`);
    const d = deps[k % Math.max(1, deps.length)];
    if (d && k < 3) L.push(`    total += ${d.fns[0]}(total % 7)`);
    L.push(`    for i in range(3):\n        total = max(0, total - i)`);
    L.push(`    return total\n`);
  });
  const parent = deps[0];
  const ext = parent && rand() < 0.5 ? `(${parent.cls})` : '';
  L.push(`class ${info.cls}${ext}:`);
  L.push(`    """Coordinates ${info.w} work for package ${info.pkg}."""\n`);
  for (let m = 0; m < 4; m++) {
    L.push(`    def step${m}(self, value):`);
    L.push(`        """Step ${m} of the ${info.w} flow."""`);
    L.push(m > 0 ? `        prev = self.step${m - 1}(value)` : `        prev = ${info.fns[0]}(value)`);
    L.push(`        return prev + ${m}\n`);
  }
  L.push(`def _internal${info.i}(xs):\n    return sum(${info.fns[2]}(x) for x in xs)\n`);
  L.push(`${info.w.toUpperCase()}_DEFAULT_${info.i} = _internal${info.i}([1, 2, 3])`);
  return L.join('\n') + '\n';
}

export function writeAuditRepo(dir, files) {
  const rand = rng(files * 7919 + 17);
  const infos = Array.from({ length: files }, (_, i) => fileInfo(i));
  const pkgs = new Set();
  for (const info of infos) {
    const deps = pickDeps(info.i, rand, infos);
    const p = join(dir, relPath(info));
    const d = p.slice(0, p.lastIndexOf('/'));
    if (!pkgs.has(d)) {
      mkdirSync(d, { recursive: true });
      if (info.lang === 'py') {
        writeFileSync(join(d, '__init__.py'), '');
        mkdirSync(join(dir, 'py'), { recursive: true });
        writeFileSync(join(dir, 'py', '__init__.py'), '');
      }
      pkgs.add(d);
    }
    writeFileSync(p, info.lang === 'py' ? pyFile(info, deps, rand) : tsFile(info, deps, rand));
  }
  return infos.map(relPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, n] = process.argv.slice(2);
  if (!dir || !n) {
    console.error('usage: node scripts/audit-repo.mjs <dir> <files>');
    process.exit(2);
  }
  writeAuditRepo(dir, Number(n));
}
