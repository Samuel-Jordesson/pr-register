// Ciclo de vida: iniciar, parar, reiniciar, e leitura do estado real.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { isAlive, killTree, ports, portFromLog, memory } from './proc.js';

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.js');

/**
 * Sobe um comando em segundo plano.
 * @returns {object} o registro do processo
 */
export function start(command, { cwd = process.cwd(), name, env } = {}) {
  store.ensureDirs();

  const finalName = name ? store.safeName(name) : store.nameForCwd(cwd, command);
  const existing = store.read(finalName);
  if (existing && liveStatus(existing).status !== 'stopped') {
    const err = new Error(`"${finalName}" já está rodando (pr restart ${finalName})`);
    err.code = 'ALREADY_RUNNING';
    throw err;
  }

  const proc = store.write({
    id: existing?.id ?? store.nextId(),
    name: finalName,
    command,
    cwd,
    env: env || {},
    status: 'starting',
    pid: null,
    supervisorPid: null,
    exitCode: null,
    restarts: 0,
    createdAt: existing?.createdAt ?? Date.now(),
    startedAt: Date.now(),
  });

  // trunca o log a cada start para o `pr logs` não misturar execuções
  fs.writeFileSync(store.logFile(finalName), '');
  fs.writeFileSync(store.errFile(finalName), '');

  const sup = spawn(process.execPath, [SUPERVISOR, finalName], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PR_HOME: store.HOME },
  });
  sup.unref();

  return store.update(finalName, { supervisorPid: sup.pid });
}

export async function stop(proc) {
  const sup = proc.supervisorPid;
  if (sup && isAlive(sup)) {
    process.kill(sup, 'SIGTERM');
    // dá tempo do supervisor derrubar a árvore e marcar o estado
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && isAlive(sup)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isAlive(sup)) process.kill(sup, 'SIGKILL');
  }

  if (proc.pid && isAlive(proc.pid)) await killTree(proc.pid);

  return store.update(proc.name, { status: 'stopped', pid: null, supervisorPid: null });
}

export async function restart(proc) {
  await stop(proc);
  return start(proc.command, { cwd: proc.cwd, name: proc.name, env: proc.env });
}

/**
 * Estado real do processo — o arquivo pode estar desatualizado se a
 * máquina reiniciou ou alguém matou o processo por fora.
 */
export function liveStatus(proc) {
  const supAlive = isAlive(proc.supervisorPid);
  const childAlive = isAlive(proc.pid);

  if (!supAlive && !childAlive) {
    const status = proc.status === 'errored' ? 'errored' : 'stopped';
    return { ...proc, status, pid: null, alive: false };
  }
  if (supAlive && !childAlive) {
    return { ...proc, status: proc.status === 'starting' ? 'starting' : 'restarting', alive: true };
  }
  return { ...proc, status: 'online', alive: true };
}

/** Registro enriquecido com porta e memória, para exibição. */
export function inspect(proc) {
  const live = liveStatus(proc);
  if (!live.alive || !live.pid) {
    return { ...live, ports: [], memory: NaN };
  }

  let found = ports(live.pid);
  if (!found.length) {
    const fromLog = portFromLog(tailText(live.name, 8000));
    if (fromLog) found = [fromLog];
  }
  return { ...live, ports: found, memory: memory(live.pid) };
}

/** Últimos bytes do log, como texto. */
export function tailText(name, maxBytes = 64 * 1024) {
  const file = store.logFile(name);
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Espera o processo abrir uma porta (ou morrer), para o `pr <cmd>`
 * já mostrar onde ele subiu.
 */
export async function waitForPort(name, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = store.read(name);
    if (!proc) return null;

    const live = liveStatus(proc);
    if (!live.alive) return null;

    if (live.pid) {
      const found = ports(live.pid);
      if (found.length) return found[0];
      const fromLog = portFromLog(tailText(name, 8000));
      if (fromLog) return fromLog;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
