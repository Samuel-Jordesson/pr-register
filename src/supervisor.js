// Supervisor de um processo: mantém o comando rodando, escreve os logs
// e atualiza o registro em ~/.pr. Roda destacado, um por processo.
//
// uso: node supervisor.js <nome>

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { killTree, isAlive } from './proc.js';

const name = process.argv[2];
if (!name) {
  process.exit(64);
}

const MAX_RESTARTS = 10;
const MIN_UPTIME_MS = 2000; // abaixo disso conta como crash em loop

let stopping = false;
let child = null;
let restarts = 0;

const out = fs.createWriteStream(store.logFile(name), { flags: 'a' });
const err = fs.createWriteStream(store.errFile(name), { flags: 'a' });

function note(msg) {
  out.write(`\n[pr] ${msg}\n`);
}

function patch(fields) {
  store.update(name, { ...fields, updatedAt: Date.now() });
}

function run() {
  const proc = store.read(name);
  if (!proc) process.exit(0);

  const startedAt = Date.now();
  child = spawn(proc.command, {
    cwd: proc.cwd,
    shell: true,
    detached: true, // grupo próprio, para matar a árvore inteira
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(proc.env || {}), FORCE_COLOR: '1', PR_NAME: name },
  });

  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(err, { end: false });
  child.stderr.pipe(out, { end: false });

  patch({
    pid: child.pid,
    status: 'online',
    startedAt,
    exitCode: null,
    restarts,
  });

  child.on('exit', (code, signal) => {
    child = null;
    const uptime = Date.now() - startedAt;

    if (stopping) {
      patch({ status: 'stopped', pid: null, exitCode: code });
      finish(0);
      return;
    }

    const crashedFast = uptime < MIN_UPTIME_MS;
    const clean = code === 0 && !signal;

    if (clean) {
      note(`processo finalizou com código 0`);
      patch({ status: 'stopped', pid: null, exitCode: 0 });
      finish(0);
      return;
    }

    if (restarts >= MAX_RESTARTS) {
      note(`parou após ${restarts} reinícios (código ${code ?? signal})`);
      patch({ status: 'errored', pid: null, exitCode: code });
      finish(1);
      return;
    }

    restarts++;
    const delay = crashedFast ? Math.min(200 * 2 ** restarts, 8000) : 200;
    note(`saiu com ${signal || `código ${code}`}, reiniciando em ${delay}ms (${restarts}/${MAX_RESTARTS})`);
    patch({ status: 'restarting', pid: null, exitCode: code, restarts });
    setTimeout(run, delay);
  });

  child.on('error', (e) => {
    err.write(`\n[pr] falha ao iniciar: ${e.message}\n`);
    patch({ status: 'errored', pid: null });
    finish(1);
  });
}

function finish(code) {
  out.end();
  err.end();
  setTimeout(() => process.exit(code), 50);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const pid = child?.pid;
  if (pid && isAlive(pid)) {
    await killTree(pid);
  } else {
    patch({ status: 'stopped', pid: null });
    finish(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

patch({ supervisorPid: process.pid, status: 'starting' });
run();
