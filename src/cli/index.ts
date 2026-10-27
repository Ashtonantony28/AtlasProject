#!/usr/bin/env node
import { nameCorrupt } from '../core/db/database.js';
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    nameCorrupt(err);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`atlas: ${msg}\n`);
    process.exit(1);
  });
