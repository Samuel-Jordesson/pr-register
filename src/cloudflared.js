// Garante o binário do cloudflared na máquina, baixando se faltar.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME } from './store.js';

const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

const ARCHS = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: '386',
};

const localBin = () => path.join(HOME, 'bin', 'cloudflared');

/** Onde está o cloudflared, se estiver em algum lugar. */
export function find() {
  const nosso = localBin();
  if (fs.existsSync(nosso)) return nosso;

  try {
    const encontrado = execFileSync('sh', ['-c', 'command -v cloudflared'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return encontrado || null;
  } catch {
    return null;
  }
}

export function version(binario) {
  try {
    return execFileSync(binario, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Baixa o cloudflared para ~/.pr/bin. Fica na pasta do usuário de
 * propósito: não precisa de sudo e não disputa nada do sistema.
 * @param {(msg:string)=>void} log
 * @returns {Promise<string>} caminho do binário
 */
export async function install(log = () => {}) {
  const arch = ARCHS[process.arch];
  if (!arch) throw new Error(`arquitetura não suportada pelo cloudflared: ${process.arch}`);
  if (os.platform() !== 'linux') throw new Error('o download automático só cobre Linux');

  const url = `${RELEASE}/cloudflared-linux-${arch}`;
  const destino = localBin();
  const temporario = `${destino}.baixando`;

  log(`baixando o cloudflared (${arch})`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download falhou (${res.status}) em ${url}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error('o arquivo baixado veio pequeno demais para ser o cloudflared');

  fs.writeFileSync(temporario, bytes, { mode: 0o755 });
  fs.renameSync(temporario, destino);

  const v = version(destino);
  if (!v) {
    fs.rmSync(destino, { force: true });
    throw new Error('o binário baixado não executou nesta máquina');
  }

  log(`cloudflared pronto: ${v}`);
  return destino;
}

/** Acha o cloudflared, baixando se ainda não existir. */
export async function ensure(log = () => {}) {
  const existente = find();
  if (existente && version(existente)) return existente;
  return install(log);
}
