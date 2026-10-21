#!/usr/bin/env node
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`atlas: ${msg}\n`);
    process.exit(1);
  });
