// Estado persistido em ~/.pr — um arquivo JSON por processo, logs ao lado.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.PR_HOME || path.join(os.homedir(), '.pr');
export const PROCS_DIR = path.join(HOME, 'procs');
export const LOGS_DIR = path.join(HOME, 'logs');

export function ensureDirs() {
  fs.mkdirSync(PROCS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const procFile = (name) => path.join(PROCS_DIR, `${name}.json`);
export const logFile = (name) => path.join(LOGS_DIR, `${name}.log`);
export const errFile = (name) => path.join(LOGS_DIR, `${name}-error.log`);

/** Nomes só com [a-zA-Z0-9._-] para não escapar do diretório. */
export function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '') || 'app';
}

export function read(name) {
  try {
    return JSON.parse(fs.readFileSync(procFile(name), 'utf8'));
  } catch {
    return null;
  }
}

export function write(proc) {
  ensureDirs();
  fs.writeFileSync(procFile(proc.name), JSON.stringify(proc, null, 2));
  return proc;
}

export function update(name, patch) {
  const proc = read(name);
  if (!proc) return null;
  return write({ ...proc, ...patch });
}

export function remove(name) {
  fs.rmSync(procFile(name), { force: true });
}

export function list() {
  ensureDirs();
  return fs
    .readdirSync(PROCS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => read(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Resolve um alvo informado pelo usuário: nome exato, id numérico,
 * ou prefixo único de nome.
 */
export function resolve(target) {
  const procs = list();
  const exact = procs.find((p) => p.name === target);
  if (exact) return exact;

  const byId = procs.find((p) => String(p.id) === String(target));
  if (byId) return byId;

  const matches = procs.filter((p) => p.name.startsWith(target));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `"${target}" é ambíguo: ${matches.map((p) => p.name).join(', ')}`
    );
    err.ambiguous = true;
    throw err;
  }
  return null;
}

/** Menor id livre, para ficar estável e curto como no pm2. */
export function nextId() {
  const used = new Set(list().map((p) => p.id));
  let id = 0;
  while (used.has(id)) id++;
  return id;
}

/** Nome derivado do diretório do projeto, com sufixo se já existir. */
export function nameForCwd(cwd, command) {
  const base = safeName(path.basename(cwd) || 'app');
  const taken = new Set(list().map((p) => p.name));
  if (!taken.has(base)) return base;

  // já existe um processo com esse nome: tenta diferenciar pelo script
  const hint = safeName((command.match(/[\w:.-]+$/) || [''])[0]);
  if (hint && hint !== base && !taken.has(`${base}-${hint}`)) return `${base}-${hint}`;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
