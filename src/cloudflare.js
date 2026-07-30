// Cliente da API da Cloudflare e guarda das credenciais.
// Só o que o fluxo de túnel precisa: verificar acesso, listar contas e
// zonas, criar túnel e apontar o DNS.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, ensureDirs } from './store.js';

export const API = process.env.PR_CF_API || 'https://api.cloudflare.com/client/v4';

const credsFile = () => path.join(HOME, 'cloudflare.json');
export const CF_DIR = () => path.join(HOME, 'cloudflare');

// ── credenciais ──────────────────────────────────────────────────────────

/** @typedef {{mode:'token'|'global', token?:string, email?:string, key?:string, accountId?:string, accountName?:string}} Credenciais */

/** @returns {Credenciais|null} */
export function credentials() {
  try {
    return JSON.parse(fs.readFileSync(credsFile(), 'utf8'));
  } catch {
    return null;
  }
}

export function saveCredentials(creds) {
  ensureDirs();
  fs.writeFileSync(credsFile(), JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

export function forgetCredentials() {
  fs.rmSync(credsFile(), { force: true });
}

function authHeaders(creds) {
  if (creds.mode === 'token') return { authorization: `Bearer ${creds.token}` };
  return { 'x-auth-email': creds.email, 'x-auth-key': creds.key };
}

// ── transporte ───────────────────────────────────────────────────────────

/**
 * Chamada à API. A Cloudflare devolve sempre um envelope
 * `{ success, errors, result }` — aqui ele vira resultado ou exceção.
 */
export async function call(creds, endpoint, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      ...authHeaders(creds),
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`resposta inesperada da Cloudflare (${res.status})`);
  }

  if (!payload.success) {
    const detalhe = (payload.errors || [])
      .map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`)
      .join('; ');
    throw new Error(detalhe || `a Cloudflare recusou (${res.status})`);
  }

  return payload.result;
}

/** Confere se a credencial funciona. @returns {Promise<string>} descrição de quem entrou */
export async function verify(creds) {
  if (creds.mode === 'token') {
    const r = await call(creds, '/user/tokens/verify');
    if (r.status !== 'active') throw new Error(`o token está "${r.status}", não ativo`);
    return 'token válido';
  }
  const user = await call(creds, '/user');
  return user.email || 'conta válida';
}

export function accounts(creds) {
  return call(creds, '/accounts?per_page=50');
}

/** Zonas (domínios) da conta. */
export function zones(creds, accountId) {
  const filtro = accountId ? `&account.id=${accountId}` : '';
  return call(creds, `/zones?per_page=50&status=active${filtro}`);
}

// ── túneis ───────────────────────────────────────────────────────────────

export function tunnels(creds, accountId) {
  return call(creds, `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=50`);
}

/**
 * Cria um túnel. O segredo é nosso: fica no arquivo de credenciais que o
 * cloudflared usa para se autenticar, e nunca passa por linha de comando.
 * @returns {Promise<{id:string, name:string, secret:string}>}
 */
export async function createTunnel(creds, accountId, name) {
  const secret = crypto.randomBytes(32).toString('base64');
  const tunnel = await call(creds, `/accounts/${accountId}/cfd_tunnel`, {
    method: 'POST',
    body: { name, tunnel_secret: secret, config_src: 'local' },
  });
  return { id: tunnel.id, name: tunnel.name, secret };
}

export function deleteTunnel(creds, accountId, tunnelId) {
  return call(creds, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' });
}

// ── DNS ──────────────────────────────────────────────────────────────────

/**
 * Aponta o hostname para o túnel (CNAME para <id>.cfargotunnel.com,
 * proxied). Se já existir um registro com esse nome, ele é atualizado —
 * é o caso de trocar um domínio de projeto.
 */
export async function pointToTunnel(creds, zoneId, hostname, tunnelId) {
  const alvo = `${tunnelId}.cfargotunnel.com`;
  const existentes = await call(
    creds,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`
  );

  const registro = {
    type: 'CNAME',
    name: hostname,
    content: alvo,
    proxied: true,
    ttl: 1, // automático
    comment: 'criado pelo PR System',
  };

  const conflito = existentes.find((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
  if (conflito) {
    return call(creds, `/zones/${zoneId}/dns_records/${conflito.id}`, {
      method: 'PUT',
      body: registro,
    });
  }

  return call(creds, `/zones/${zoneId}/dns_records`, { method: 'POST', body: registro });
}

// ── registro local dos túneis ────────────────────────────────────────────

const tunnelsFile = () => path.join(CF_DIR(), 'tunnels.json');

/** @typedef {{process:string, hostname:string, zoneId:string, zoneName:string, tunnelId:string, tunnelName:string, port:number, createdAt:number}} Vinculo */

/** @returns {Vinculo[]} */
export function links() {
  try {
    return JSON.parse(fs.readFileSync(tunnelsFile(), 'utf8'));
  } catch {
    return [];
  }
}

export function saveLink(link) {
  fs.mkdirSync(CF_DIR(), { recursive: true });
  const resto = links().filter((l) => l.hostname !== link.hostname);
  const todos = [...resto, link];
  fs.writeFileSync(tunnelsFile(), JSON.stringify(todos, null, 2));
  return link;
}

export function removeLink(hostname) {
  const restante = links().filter((l) => l.hostname !== hostname);
  fs.mkdirSync(CF_DIR(), { recursive: true });
  fs.writeFileSync(tunnelsFile(), JSON.stringify(restante, null, 2));
}

/** Nome do processo que o `pr` usa para rodar o túnel. */
export function tunnelProcessName(processName) {
  return `cf-${processName}`;
}

// ── arquivos que o cloudflared lê ────────────────────────────────────────

export function tunnelPaths(tunnelId) {
  const dir = CF_DIR();
  return {
    dir,
    credentials: path.join(dir, `${tunnelId}.json`),
    config: path.join(dir, `${tunnelId}.yml`),
  };
}

/** O arquivo de credenciais no formato que o cloudflared espera. */
export function writeTunnelCredentials({ accountId, tunnelId, tunnelName, secret }) {
  const { dir, credentials: file } = tunnelPaths(tunnelId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      AccountTag: accountId,
      TunnelID: tunnelId,
      TunnelName: tunnelName,
      TunnelSecret: secret,
    }),
    { mode: 0o600 }
  );
  return file;
}

/**
 * config.yml do túnel: cada hostname aponta para a porta local do seu
 * projeto, e o que não casar recebe 404.
 * @param {{hostname:string, port:number}[]} rotas
 */
export function writeTunnelConfig(tunnelId, rotas) {
  const { dir, credentials, config } = tunnelPaths(tunnelId);
  fs.mkdirSync(dir, { recursive: true });

  const linhas = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentials}`,
    'ingress:',
    ...rotas.flatMap((r) => [`  - hostname: ${r.hostname}`, `    service: http://localhost:${r.port}`]),
    '  - service: http_status:404',
    '',
  ];

  fs.writeFileSync(config, linhas.join('\n'));
  return config;
}
