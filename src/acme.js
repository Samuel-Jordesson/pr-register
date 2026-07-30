// Cliente ACME v2 (Let's Encrypt) com desafio HTTP-01, sem dependências.
// Fluxo: conta → pedido → autorizações → desafios → CSR → certificado.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, ensureDirs } from './store.js';
import * as asn1 from './asn1.js';

export const DIRECTORY_URL =
  process.env.PR_ACME_DIRECTORY || 'https://acme-v02.api.letsencrypt.org/directory';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const json = (obj) => Buffer.from(JSON.stringify(obj));

// ── conta ────────────────────────────────────────────────────────────────

const accountKeyPath = () => path.join(HOME, 'acme-account.pem');

function accountKey() {
  ensureDirs();
  const file = accountKeyPath();
  if (fs.existsSync(file)) {
    return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return crypto.createPrivateKey(pem);
}

function publicJwk(key) {
  const { x, y, crv, kty } = crypto.createPublicKey(key).export({ format: 'jwk' });
  return { crv, kty, x, y }; // ordem lexicográfica, exigida no thumbprint
}

function thumbprint(key) {
  return b64(crypto.createHash('sha256').update(JSON.stringify(publicJwk(key))).digest());
}

function signES256(key, data) {
  return crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
}

// ── transporte ───────────────────────────────────────────────────────────

export class AcmeClient {
  constructor({ contact = [], directoryUrl = DIRECTORY_URL, log = () => {} } = {}) {
    this.key = accountKey();
    this.contact = contact;
    this.directoryUrl = directoryUrl;
    this.log = log;
    this.nonce = null;
    this.kid = null;
    this.dir = null;
  }

  async directory() {
    if (!this.dir) {
      const res = await fetch(this.directoryUrl);
      if (!res.ok) throw new Error(`diretório ACME indisponível (${res.status})`);
      this.dir = await res.json();
    }
    return this.dir;
  }

  async newNonce() {
    const dir = await this.directory();
    const res = await fetch(dir.newNonce, { method: 'HEAD' });
    this.nonce = res.headers.get('replay-nonce');
    return this.nonce;
  }

  /** POST assinado (JWS flattened). payload === null faz POST-as-GET. */
  async post(url, payload, { kid = this.kid } = {}) {
    if (!this.nonce) await this.newNonce();

    const protectedHeader = {
      alg: 'ES256',
      nonce: this.nonce,
      url,
      ...(kid ? { kid } : { jwk: publicJwk(this.key) }),
    };

    const protected64 = b64(json(protectedHeader));
    const payload64 = payload === null ? '' : b64(json(payload));
    const signature = b64(signES256(this.key, Buffer.from(`${protected64}.${payload64}`)));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({ protected: protected64, payload: payload64, signature }),
    });

    this.nonce = res.headers.get('replay-nonce') || null;

    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();

    if (res.status === 400 && body?.type?.endsWith('badNonce')) {
      await this.newNonce();
      return this.post(url, payload, { kid });
    }
    if (!res.ok) {
      throw new Error(body?.detail || `ACME ${res.status} em ${url}`);
    }
    return { body, headers: res.headers };
  }

  async register() {
    const dir = await this.directory();
    const { headers } = await this.post(
      dir.newAccount,
      { termsOfServiceAgreed: true, contact: this.contact },
      { kid: null }
    );
    this.kid = headers.get('location');
    this.log(`conta ACME: ${this.kid}`);
    return this.kid;
  }

  /** Resposta esperada no desafio HTTP-01. */
  keyAuthorization(token) {
    return `${token}.${thumbprint(this.key)}`;
  }

  /**
   * Emite um certificado para os domínios informados.
   * @param {string[]} domains primeiro item vira o CN
   * @param {(token:string, keyAuth:string)=>void} publish registra o desafio
   * @param {(token:string)=>void} unpublish remove o desafio
   * @returns {Promise<{cert:string, key:string}>} PEMs
   */
  async issue(domains, publish, unpublish) {
    if (!this.kid) await this.register();
    const dir = await this.directory();

    this.log(`pedido para ${domains.join(', ')}`);
    const { body: order, headers } = await this.post(dir.newOrder, {
      identifiers: domains.map((value) => ({ type: 'dns', value })),
    });
    const orderUrl = headers.get('location');

    const published = [];
    try {
      for (const authzUrl of order.authorizations) {
        const { body: authz } = await this.post(authzUrl, null);
        if (authz.status === 'valid') continue;

        const challenge = authz.challenges.find((ch) => ch.type === 'http-01');
        if (!challenge) throw new Error(`sem desafio http-01 para ${authz.identifier.value}`);

        publish(challenge.token, this.keyAuthorization(challenge.token));
        published.push(challenge.token);

        await this.post(challenge.url, {});
        await this.waitFor(authzUrl, ['valid'], `validação de ${authz.identifier.value}`);
      }

      const { key, csr } = createCsr(domains);
      const { body: finalized } = await this.post(order.finalize, { csr: b64(csr) });

      let ready = finalized;
      if (ready.status !== 'valid') {
        ready = await this.waitFor(orderUrl, ['valid'], 'emissão do certificado');
      }

      const { body: cert } = await this.post(ready.certificate, null);
      this.log('certificado emitido');
      return { cert: String(cert), key };
    } finally {
      for (const token of published) {
        try {
          unpublish(token);
        } catch {
          // desafio já removido
        }
      }
    }
  }

  async waitFor(url, states, what, { attempts = 30, delayMs = 2000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const { body } = await this.post(url, null);
      if (states.includes(body.status)) return body;
      if (body.status === 'invalid') {
        const problem =
          body.error?.detail ||
          body.challenges?.find((ch) => ch.error)?.error?.detail ||
          'sem detalhes';
        throw new Error(`${what} falhou: ${problem}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`${what}: tempo esgotado`);
  }
}

// ── CSR ──────────────────────────────────────────────────────────────────

const OID = {
  commonName: '2.5.4.3',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

/**
 * Gera a chave do certificado e o CSR (DER) para os domínios.
 * @returns {{key:string, csr:Buffer}}
 */
export function createCsr(domains) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const subject = asn1.seq(
    asn1.set(asn1.seq(asn1.oid(OID.commonName), asn1.utf8(domains[0])))
  );

  const spki = asn1.raw(publicKey.export({ type: 'spki', format: 'der' }));

  const san = asn1.seq(
    asn1.oid(OID.subjectAltName),
    asn1.octetString(asn1.seq(...domains.map(asn1.dnsName)))
  );
  const attributes = asn1.context(
    0,
    asn1.seq(asn1.oid(OID.extensionRequest), asn1.set(asn1.seq(san)))
  );

  const info = asn1.seq(asn1.int(0), subject, spki, attributes);
  const signature = crypto.sign('sha256', info, privateKey); // DER, como o X.509 espera

  const csr = asn1.seq(info, asn1.seq(asn1.oid(OID.ecdsaWithSha256)), asn1.bitString(signature));

  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), csr };
}
