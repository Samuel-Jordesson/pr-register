// Mapa domínio → processo, em ~/.pr/domains.json.

import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { HOME, ensureDirs } from './store.js';

const FILE = () => path.join(HOME, 'domains.json');
export const CERTS_DIR = () => path.join(HOME, 'certs');

/** @typedef {{domain:string, process:string, www:boolean, createdAt:number, issuedAt?:number, lastError?:string}} Binding */

/** @returns {Binding[]} */
export function all() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(data.domains) ? data.domains : [];
  } catch {
    return [];
  }
}

function save(domains) {
  ensureDirs();
  fs.writeFileSync(FILE(), JSON.stringify({ domains }, null, 2));
}

export function get(domain) {
  return all().find((b) => b.domain === normalize(domain)) || null;
}

/** Domínios apontando para um processo. */
export function forProcess(name) {
  return all().filter((b) => b.process === name);
}

export function add({ domain, process: proc, www = true }) {
  const d = normalize(domain);
  const rest = all().filter((b) => b.domain !== d);
  const binding = { domain: d, process: proc, www, createdAt: Date.now() };
  save([...rest, binding]);
  return binding;
}

export function update(domain, patch) {
  const d = normalize(domain);
  const current = all();
  const before = current.find((b) => b.domain === d);
  if (!before) return null;

  const after = { ...before, ...patch };
  // gravar sem mudança nada acorda quem observa o arquivo — e o proxy observa
  const changed = Object.keys(patch).some((k) => before[k] !== after[k]);
  if (!changed) return before;

  save(current.map((b) => (b.domain === d ? after : b)));
  return after;
}

export function remove(domain) {
  const d = normalize(domain);
  save(all().filter((b) => b.domain !== d));
  fs.rmSync(path.join(CERTS_DIR(), d), { recursive: true, force: true });
}

/** Todos os nomes servidos por um vínculo (com e sem www). */
export function hostnames(binding) {
  const names = [binding.domain];
  if (binding.www && !binding.domain.startsWith('www.') && binding.domain.split('.').length <= 3) {
    names.push(`www.${binding.domain}`);
  }
  return names;
}

export function normalize(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

/** Valida um nome de domínio ao estilo "tem pelo menos um ponto e nada estranho". */
export function isValid(input) {
  const d = normalize(input);
  if (d.length < 4 || d.length > 253) return false;
  if (!d.includes('.')) return false;
  return d.split('.').every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) && label.length <= 63);
}

/** Caminhos do certificado de um domínio. */
export function certPaths(domain) {
  const dir = path.join(CERTS_DIR(), normalize(domain));
  return { dir, key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem') };
}

/** Certificado válido em disco? @returns {{ok:boolean, expiresAt?:number}} */
export function certInfo(domain) {
  const { key, cert } = certPaths(domain);
  try {
    const pem = fs.readFileSync(cert, 'utf8');
    fs.accessSync(key);
    const x = new X509Certificate(pem);
    return { ok: true, expiresAt: Date.parse(x.validTo) };
  } catch {
    return { ok: false };
  }
}
