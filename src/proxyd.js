// Entrada do daemon do proxy. Roda destacado; logs em ~/.pr/logs/_proxy.log.

import fs from 'node:fs';
import { createProxy, statePath } from './proxy.js';
import { ensureDirs, logFile } from './store.js';

ensureDirs();

const out = fs.createWriteStream(logFile('_proxy'), { flags: 'a' });
const log = (msg) => out.write(`${new Date().toISOString()} ${msg}\n`);

const proxy = createProxy({ log });

async function shutdown() {
  log('encerrando');
  try {
    await proxy.stop();
  } finally {
    fs.rmSync(statePath(), { force: true });
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => log(`erro não tratado: ${err.stack || err.message}`));

try {
  await proxy.start();
  fs.writeFileSync(
    statePath(),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), ports: proxy.ports }, null, 2)
  );
  log('proxy no ar');
} catch (err) {
  log(`não subiu: ${err.code || ''} ${err.message}`);
  fs.writeFileSync(statePath(), JSON.stringify({ error: err.code || err.message, at: Date.now() }));
  process.exit(1);
}
