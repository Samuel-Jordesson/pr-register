#!/usr/bin/env node
import { main } from '../src/cli.js';
import { fail } from '../src/ui.js';

main(process.argv.slice(2)).catch((err) => {
  fail(err?.message || String(err));
  process.exit(1);
});
