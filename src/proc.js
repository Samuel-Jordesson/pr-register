// Inspeção de processos e descoberta de portas via /proc (Linux) e ss/lsof.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Todos os descendentes de um pid, incluindo ele mesmo. */
export function processTree(pid) {
  const children = new Map();
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [pid];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // o comm pode conter espaços e parênteses: corta depois do último ')'
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(after[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch {
      // processo terminou entre readdir e read
    }
  }

  const out = [];
  const stack = [pid];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const child of children.get(cur) || []) stack.push(child);
  }
  return out;
}

/** Uso de memória (RSS em bytes) da árvore do processo. */
export function memory(pid) {
  let total = 0;
  for (const p of processTree(pid)) {
    try {
      const statm = fs.readFileSync(`/proc/${p}/statm`, 'utf8').split(' ');
      total += Number(statm[1]) * 4096; // páginas residentes
    } catch {
      // ignora
    }
  }
  return total || NaN;
}

function listeningFromSs() {
  // `ss -tlnpH` → LISTEN 0 511 *:3000 *:* users:(("node",pid=123,fd=20))
  let out;
  try {
    out = execFileSync('ss', ['-tlnpH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }

  const found = [];
  for (const line of out.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const port = local && Number(local.slice(local.lastIndexOf(':') + 1));
    if (!port) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      found.push({ pid: Number(m[1]), port });
    }
  }
  return found;
}

function listeningFromLsof(pids) {
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = [];
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const addr = cols[8];
      if (!addr) continue;
      const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
      if (port) found.push({ pid: Number(cols[1]), port });
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * Portas TCP em LISTEN abertas pela árvore do processo.
 * @returns {number[]} portas ordenadas, sem repetição
 */
export function ports(pid) {
  const tree = processTree(pid);
  if (!tree.length) return [];
  const mine = new Set(tree);

  const rows = listeningFromSs() ?? listeningFromLsof(tree) ?? [];
  const found = new Set();
  for (const row of rows) {
    if (mine.has(row.pid)) found.add(row.port);
  }
  return [...found].sort((a, b) => a - b);
}

/** Porta anunciada no log, quando o processo não expõe socket detectável. */
export function portFromLog(text) {
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/i,
    /\b(?:port|porta|listening on|servidor em)\D{0,12}(\d{2,5})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const port = Number(m[1]);
      if (port >= 80 && port <= 65535) return port;
    }
  }
  return null;
}

/** Mata a árvore: TERM no grupo, KILL depois do prazo. */
export async function killTree(pid, { signal = 'SIGTERM', graceMs = 4000 } = {}) {
  if (!isAlive(pid)) return false;

  try {
    process.kill(-pid, signal); // grupo criado por detached: true
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return false;
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  for (const p of processTree(pid).reverse()) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // já morreu
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // grupo já vazio
  }
  return true;
}
