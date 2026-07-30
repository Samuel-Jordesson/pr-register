// Sobe, para e consulta o daemon do proxy.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './store.js';
import { statePath } from './proxy.js';
import { isAlive } from './proc.js';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxyd.js');

export function state() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

export function status() {
  const s = state();
  if (!s) return { running: false };
  if (s.error) return { running: false, error: s.error };
  if (!isAlive(s.pid)) return { running: false, stale: true };
  return { running: true, ...s };
}

/**
 * Sobe o daemon e espera ele confirmar (ou falhar).
 * @returns {Promise<{running:boolean, error?:string, pid?:number}>}
 */
export async function start({ timeoutMs = 8000 } = {}) {
  const current = status();
  if (current.running) return current;

  fs.rmSync(statePath(), { force: true });

  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PR_HOME: HOME },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = state();
    if (s?.pid && isAlive(s.pid)) return { running: true, ...s };
    if (s?.error) return { running: false, error: s.error };
    if (!isAlive(child.pid) && !s) {
      return { running: false, error: 'o daemon saiu sem explicar (veja pr proxy logs)' };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { running: false, error: 'tempo esgotado ao subir o proxy' };
}

export async function stop() {
  const s = status();
  if (!s.running) {
    fs.rmSync(statePath(), { force: true });
    return false;
  }

  process.kill(s.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(s.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isAlive(s.pid)) process.kill(s.pid, 'SIGKILL');
  fs.rmSync(statePath(), { force: true });
  return true;
}

/** Mensagem de ajuda para o caso clássico de porta 80 sem permissão. */
export function permissionHint() {
  return [
    'A porta 80 exige privilégio. Duas saídas:',
    '',
    `  sudo setcap 'cap_net_bind_service=+ep' ${process.execPath}`,
    '  (libera o node para portas baixas, uma vez só)',
    '',
    '  sudo pr proxy start',
    '  (roda o proxy como root)',
  ].join('\n');
}
