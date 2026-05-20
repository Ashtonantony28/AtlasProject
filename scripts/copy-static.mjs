// Copy src/web/static -> dist/web/static after tsc builds.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '..', 'src', 'web', 'static');
const dst = resolve(__dirname, '..', 'dist', 'web', 'static');

if (!existsSync(src)) {
  console.error(`copy-static: source not found: ${src}`);
  process.exit(0);
}
mkdirSync(dirname(dst), { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copy-static: copied ${src} -> ${dst}`);
