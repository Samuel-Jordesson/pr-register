// Proxy reverso: roteia por Host para a porta do projeto, resolve os
// desafios ACME e mantém os certificados em dia.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import * as store from './store.js';
import * as domains from './domains.js';
import * as runner from './runner.js';
import { AcmeClient } from './acme.js';
import { publicIp, pointsHere } from './net.js';

const HTTP_PORT = Number(process.env.PR_HTTP_PORT || 80);
const HTTPS_PORT = Number(process.env.PR_HTTPS_PORT || 443);
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const PORT_CACHE_MS = 5000;
const RECONCILE_MS = 60_000;

export const statePath = () => path.join(store.HOME, 'proxy.json');

export function createProxy({ log = console.log } = {}) {
  /** desafios ACME ativos: token → keyAuthorization */
  const challenges = new Map();
  /** porta de cada processo, com cache curto (descobrir porta chama `ss`) */
  const portCache = new Map();
  /** certificados carregados: domínio → SecureContext */
  const contexts = new Map();
  const issuing = new Set();
  let serverIp = null;

  // ── roteamento ─────────────────────────────────────────────────────────

  function bindingFor(host) {
    if (!host) return null;
    const name = host.split(':')[0].toLowerCase();
    return (
      domains.all().find((b) => domains.hostnames(b).includes(name)) ||
      // subdomínio de um domínio registrado cai no mesmo projeto
      domains.all().find((b) => name.endsWith(`.${b.domain}`)) ||
      null
    );
  }

  function targetPort(processName) {
    const cached = portCache.get(processName);
    if (cached && Date.now() - cached.at < PORT_CACHE_MS) return cached.port;

    const proc = store.read(processName);
    const port = proc ? (runner.inspect(proc).ports[0] ?? null) : null;
    portCache.set(processName, { port, at: Date.now() });
    return port;
  }

  function fail(res, code, message) {
    const body = `${code} ${message}\n`;
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function proxyRequest(req, res) {
    const binding = bindingFor(req.headers.host);
    if (!binding) return fail(res, 404, 'nenhum projeto registrado para este domínio');

    const port = targetPort(binding.process);
    if (!port) return fail(res, 502, `"${binding.process}" não está no ar`);

    const proxied = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          'x-forwarded-for': req.socket.remoteAddress,
          'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http',
          'x-forwarded-host': req.headers.host,
        },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      }
    );

    proxied.on('error', (err) => {
      if (!res.headersSent) fail(res, 502, `erro ao falar com ${binding.process}: ${err.code || err.message}`);
      else res.destroy();
    });

    req.pipe(proxied);
  }

  /** WebSocket e outros upgrades. */
  function proxyUpgrade(req, socket, head) {
    const binding = bindingFor(req.headers.host);
    const port = binding && targetPort(binding.process);
    if (!port) return socket.destroy();

    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    });

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const head1 = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${head1}\r\n\r\n`);
      if (upHead?.length) socket.unshift(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  }

  // ── servidores ─────────────────────────────────────────────────────────

  const plain = http.createServer((req, res) => {
    // desafio ACME sempre em http, antes de qualquer redirecionamento
    const challenge = req.url.match(/^\/\.well-known\/acme-challenge\/([\w-]+)$/);
    if (challenge) {
      const keyAuth = challenges.get(challenge[1]);
      log(`desafio ${challenge[1].slice(0, 8)}… ${keyAuth ? 'entregue' : 'desconhecido'}`);
      if (!keyAuth) return fail(res, 404, 'desafio desconhecido');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(keyAuth);
    }

    const binding = bindingFor(req.headers.host);
    if (binding && domains.certInfo(binding.domain).ok) {
      const host = req.headers.host.split(':')[0];
      const suffix = HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`;
      res.writeHead(301, { location: `https://${host}${suffix}${req.url}` });
      return res.end();
    }

    proxyRequest(req, res);
  });
  plain.on('upgrade', proxyUpgrade);

  function contextFor(domain) {
    const { key, cert } = domains.certPaths(domain);
    const cached = contexts.get(domain);
    let mtime;
    try {
      mtime = fs.statSync(cert).mtimeMs;
    } catch {
      return null;
    }
    if (cached?.mtime === mtime) return cached.context;

    const context = tls.createSecureContext({
      key: fs.readFileSync(key),
      cert: fs.readFileSync(cert),
    });
    contexts.set(domain, { context, mtime });
    return context;
  }

  const secure = https.createServer({
    SNICallback(servername, cb) {
      const binding = bindingFor(servername);
      const context = binding && contextFor(binding.domain);
      if (!context) return cb(new Error(`sem certificado para ${servername}`));
      cb(null, context);
    },
  });
  secure.on('request', proxyRequest);
  secure.on('upgrade', proxyUpgrade);
  secure.on('tlsClientError', () => {}); // handshakes sem SNI são comuns e ruidosos

  // ── emissão e renovação ────────────────────────────────────────────────

  async function ensureCert(binding) {
    const { domain } = binding;
    if (issuing.has(domain)) return;

    const info = domains.certInfo(domain);
    if (info.ok && info.expiresAt - Date.now() > RENEW_BEFORE_MS) return;

    const { pointing, records } = await pointsHere(domain, serverIp);
    if (!pointing) {
      const detail = records.length
        ? `DNS aponta para ${records.join(', ')}, esperado ${serverIp}`
        : 'DNS ainda não resolve';
      domains.update(domain, { lastError: detail });
      return;
    }

    issuing.add(domain);
    try {
      // só inclui o www se ele também apontar para cá — senão a ordem inteira falha
      const usable = [];
      for (const name of domains.hostnames(binding)) {
        const check = name === domain ? { pointing: true } : await pointsHere(name, serverIp);
        if (check.pointing) usable.push(name);
        else log(`${name} ainda não aponta para cá, seguindo sem ele`);
      }

      log(`emitindo certificado para ${usable.join(', ')}`);
      const client = new AcmeClient({ log });
      const { cert, key } = await client.issue(
        usable,
        (token, keyAuth) => challenges.set(token, keyAuth),
        (token) => challenges.delete(token)
      );

      const paths = domains.certPaths(domain);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.key, key, { mode: 0o600 });
      fs.writeFileSync(paths.cert, cert);
      contexts.delete(domain);
      domains.update(domain, { issuedAt: Date.now(), lastError: null, names: usable });
      log(`${domain} pronto em https`);
    } catch (err) {
      log(`falha em ${domain}: ${err.message}`);
      domains.update(domain, { lastError: err.message });
    } finally {
      issuing.delete(domain);
    }
  }

  async function reconcile() {
    const list = domains.all();
    if (!list.length) return;
    if (!serverIp) serverIp = (await publicIp()).ip;
    for (const binding of list) await ensureCert(binding);
  }

  async function start() {
    await new Promise((resolve, reject) => {
      plain.once('error', reject);
      plain.listen(HTTP_PORT, '0.0.0.0', resolve);
    });
    log(`http na porta ${HTTP_PORT}`);

    try {
      await new Promise((resolve, reject) => {
        secure.once('error', reject);
        secure.listen(HTTPS_PORT, '0.0.0.0', resolve);
      });
      log(`https na porta ${HTTPS_PORT}`);
    } catch (err) {
      log(`sem https (${err.code || err.message}) — seguindo só em http`);
    }

    serverIp = (await publicIp()).ip;
    log(`ip do servidor: ${serverIp || 'desconhecido'}`);

    await reconcile();
    const timer = setInterval(() => reconcile().catch((e) => log(e.message)), RECONCILE_MS);
    timer.unref?.();

    // reage na hora a um `pr register`
    const file = path.join(store.HOME, 'domains.json');
    fs.watchFile(file, { interval: 1000 }, () => {
      log('domínios mudaram, reavaliando');
      reconcile().catch((e) => log(e.message));
    });

    return { plain, secure };
  }

  async function stop() {
    await Promise.all([
      new Promise((r) => plain.close(r)),
      new Promise((r) => secure.close(r)),
    ]);
  }

  return { start, stop, reconcile, challenges, ports: { http: HTTP_PORT, https: HTTPS_PORT } };
}
