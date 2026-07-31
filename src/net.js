// Descoberta do IP público e checagem de DNS.

import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';

/** IPs locais não-internos, como palpite de fallback. */
export function localIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const PUBLIC = /^(?!10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+\.\d+\.\d+$/;

/**
 * IP público do servidor. Tenta serviços de echo por HTTPS e cai para o
 * IP da interface quando não há saída para a internet.
 * @returns {Promise<{ip:string|null, source:'internet'|'local'|'none'}>}
 */
export async function publicIp({ timeoutMs = 4000 } = {}) {
  const services = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

  for (const url of services) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const ip = (await res.text()).trim();
      if (PUBLIC.test(ip)) return { ip, source: 'internet' };
    } catch {
      // tenta o próximo
    }
  }

  const local = localIps();
  const external = local.find((ip) => PUBLIC.test(ip));
  if (external) return { ip: external, source: 'internet' };
  if (local.length) return { ip: local[0], source: 'local' };
  return { ip: null, source: 'none' };
}

/**
 * Endereços A de um domínio. Consulta o resolvedor do sistema e, se ele
 * não trouxer nada, tenta resolvedores públicos — o cache negativo local
 * costuma insistir no "não existe" bem depois do registro já estar no ar.
 */
export async function resolveA(domain) {
  try {
    const records = await dns.resolve4(domain);
    if (records.length) return records;
  } catch {
    // segue para os resolvedores públicos
  }

  try {
    const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    return await resolver.resolve4(domain);
  } catch {
    return [];
  }
}

/**
 * O domínio já aponta para este servidor?
 * `extras` são outros registros A do mesmo nome: eles fazem o Let's Encrypt
 * sortear qual IP validar, então quebram a emissão de forma intermitente.
 * @returns {Promise<{pointing:boolean, records:string[], extras:string[]}>}
 */
export async function pointsHere(domain, ip) {
  const records = await resolveA(domain);
  return {
    pointing: Boolean(ip) && records.includes(ip),
    records,
    extras: ip ? records.filter((r) => r !== ip) : records,
  };
}

/**
 * Quem está ocupando uma porta TCP local.
 * @returns {{pid:number|null, nome:string}|null}
 */
export function whoHasPort(port) {
  try {
    const saida = execFileSync('ss', ['-tlnpH', `sport = :${port}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const linha = saida.split('\n').find((l) => l.trim());
    if (!linha) return null;

    const users = linha.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (!users) return { nome: null, pid: null };

    const pid = Number(users[2]);
    return { nome: nomeDoProcesso(pid) || users[1], pid };
  } catch {
    return null;
  }
}

/**
 * Nome amigável de um processo. O `ss` mostra o nome da thread — no node
 * isso sai como "MainThread" —, então a linha de comando serve melhor.
 */
function nomeDoProcesso(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const primeiro = cmdline.split('\0')[0];
    if (primeiro) {
      // "nginx: master process /usr/sbin/nginx" → nginx
      return primeiro.split(/[:\s]/)[0].split('/').pop();
    }
  } catch {
    // processo de outro usuário, ou já morreu
  }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Alguém já escuta nesta porta local? */
export async function portFree(port) {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}
