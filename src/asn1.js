// Codificador DER mínimo — o suficiente para montar um CSR (PKCS#10).

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag, payload) => Buffer.concat([Buffer.from([tag]), len(payload.length), payload]);

export const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
export const set = (...parts) => tlv(0x31, Buffer.concat(parts));
export const int = (n) => tlv(0x02, Buffer.from([n]));
export const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
export const context = (n, payload) => tlv(0xa0 | n, payload);
/** dNSName dentro de um SubjectAltName. */
export const dnsName = (host) => tlv(0x82, Buffer.from(host, 'ascii'));
export const octetString = (buf) => tlv(0x04, buf);

/** OID em notação pontuada → DER. */
export function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const body = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let v = part >> 7;
    while (v > 0) {
      chunk.unshift(0x80 | (v & 0x7f));
      v >>= 7;
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

/** Sequência DER crua (uma chave já exportada, por exemplo) usada como está. */
export const raw = (buf) => Buffer.from(buf);
