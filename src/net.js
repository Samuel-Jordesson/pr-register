// Descoberta do IP público e checagem de DNS.

import os from 'node:os';
import dns from 'node:dns/promises';

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

/** Endereços A de um domínio, consultando os servidores autoritativos atuais. */
export async function resolveA(domain) {
  try {
    return await dns.resolve4(domain);
  } catch {
    return [];
  }
}

/**
 * O domínio já aponta para este servidor?
 * @returns {Promise<{pointing:boolean, records:string[]}>}
 */
export async function pointsHere(domain, ip) {
  const records = await resolveA(domain);
  return { pointing: Boolean(ip) && records.includes(ip), records };
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
