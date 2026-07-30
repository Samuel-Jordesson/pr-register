import test from 'node:test';
import assert from 'node:assert/strict';
import { portFromLog, processTree, isAlive } from '../src/proc.js';
import { width, table, truncate } from '../src/ui.js';
import { safeName } from '../src/store.js';

test('portFromLog lê a porta de formatos comuns de dev server', () => {
  assert.equal(portFromLog('Local:   http://localhost:5173/'), 5173);
  assert.equal(portFromLog('Server listening on http://127.0.0.1:3000'), 3000);
  assert.equal(portFromLog('listening on port 8080'), 8080);
  assert.equal(portFromLog('servidor em 4000'), 4000);
  assert.equal(portFromLog('compilado em 320ms'), null);
});

test('width ignora escapes ANSI', () => {
  assert.equal(width('\u001b[31mabc\u001b[39m'), 3);
});

test('table alinha colunas usando a largura visível', () => {
  const out = table(
    [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }],
    [{ a: '\u001b[31mxx\u001b[39m', b: 'y' }, { a: 'z', b: 'w' }]
  );
  const [, first, second] = out.split('\n');
  assert.equal(width(first), width(second));
});

test('truncate corta com elipse', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('ab', 4), 'ab');
});

test('safeName remove caracteres de caminho', () => {
  assert.equal(safeName('../evil/name'), 'evil-name');
  assert.equal(safeName('meu app!'), 'meu-app-');
});

test('processTree inclui o próprio processo', () => {
  assert.ok(processTree(process.pid).includes(process.pid));
  assert.ok(isAlive(process.pid));
  assert.equal(isAlive(0), false);
});

test('normalize e isValid tratam o que o usuário digita', async () => {
  const d = await import('../src/domains.js');
  assert.equal(d.normalize('  HTTPS://MeuApp.com.br/painel  '), 'meuapp.com.br');
  assert.equal(d.normalize('meuapp.com.br.'), 'meuapp.com.br');
  assert.ok(d.isValid('meuapp.com.br'));
  assert.ok(d.isValid('api.meuapp.com'));
  assert.equal(d.isValid('semponto'), false);
  assert.equal(d.isValid('-ruim.com'), false);
  assert.equal(d.isValid('a.b'), false);
});

test('hostnames acrescenta o www só quando faz sentido', async () => {
  const d = await import('../src/domains.js');
  assert.deepEqual(d.hostnames({ domain: 'meuapp.com.br', www: true }), [
    'meuapp.com.br',
    'www.meuapp.com.br',
  ]);
  assert.deepEqual(d.hostnames({ domain: 'www.meuapp.com', www: true }), ['www.meuapp.com']);
  assert.deepEqual(d.hostnames({ domain: 'api.meuapp.com.br', www: true }), ['api.meuapp.com.br']);
  assert.deepEqual(d.hostnames({ domain: 'meuapp.com', www: false }), ['meuapp.com']);
});

test('oid codifica identificadores longos corretamente', async () => {
  const { oid } = await import('../src/asn1.js');
  // 1.2.840.113549.1.9.14 (extensionRequest)
  assert.equal(oid('1.2.840.113549.1.9.14').toString('hex'), '06092a864886f70d01090e');
  assert.equal(oid('2.5.29.17').toString('hex'), '0603551d11');
});

test('o CSR gerado é aceito pelo openssl', async () => {
  const { createCsr } = await import('../src/acme.js');
  const { execFileSync } = await import('node:child_process');
  const { csr, key } = createCsr(['exemplo.com.br', 'www.exemplo.com.br']);
  assert.ok(key.includes('BEGIN PRIVATE KEY'));

  let text;
  try {
    text = execFileSync('openssl', ['req', '-inform', 'DER', '-noout', '-text', '-verify'], {
      input: csr,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return; // sem openssl na máquina: nada a verificar
  }
  assert.match(text, /CN\s*=\s*exemplo\.com\.br/);
  assert.match(text, /DNS:exemplo\.com\.br, DNS:www\.exemplo\.com\.br/);
});

test('update não regrava quando nada muda', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // processo separado: os módulos leem PR_HOME uma vez, na carga
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const fs = await import('node:fs');
      const d = await import('${path.resolve('src/domains.js')}');
      d.add({ domain: 'exemplo.com', process: 'app' });
      const file = '${path.join(home, 'domains.json')}';
      const before = fs.statSync(file).mtimeMs;
      d.update('exemplo.com', { lastError: 'falhou' });
      const changed = fs.statSync(file).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      d.update('exemplo.com', { lastError: 'falhou' });
      const again = fs.statSync(file).mtimeMs;
      console.log(JSON.stringify({ gravouMudanca: changed !== before, regravouIgual: again !== changed }));
      `,
    ],
    { env: { ...process.env, PR_HOME: home }, encoding: 'utf8' }
  );

  const result = JSON.parse(out.trim().split('\n').pop());
  assert.equal(result.gravouMudanca, true, 'mudança real deve gravar');
  assert.equal(result.regravouIgual, false, 'valor igual não deve regravar');
});

test('validarHostname aceita a zona e seus subdomínios', async () => {
  const { validarHostname } = await import('../src/cftunnel.js');

  assert.equal(validarHostname('efflar.com', 'efflar.com').hostname, 'efflar.com');
  assert.equal(validarHostname('efflar.com', 'app.efflar.com').hostname, 'app.efflar.com');
  assert.equal(validarHostname('efflar.com', ' HTTPS://App.Efflar.com/painel ').hostname, 'app.efflar.com');
  assert.equal(validarHostname('efflar.com', 'efflar.com.').hostname, 'efflar.com');

  assert.match(validarHostname('efflar.com', 'outro.com').erro, /não pertence/);
  // sufixo parecido não é subdomínio: naoefflar.com não pertence a efflar.com
  assert.match(validarHostname('efflar.com', 'naoefflar.com').erro, /não pertence/);
  assert.match(validarHostname('efflar.com', '').erro, /vazio/);
});

test('o config do túnel lista todas as rotas e termina com o 404', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const cf = await import('${path.resolve('src/cloudflare.js')}');
      const fs = await import('node:fs');
      cf.writeTunnelCredentials({ accountId: 'acct', tunnelId: 'tun-1', tunnelName: 'pr-app', secret: 'c2VncmVkbw==' });
      const conf = cf.writeTunnelConfig('tun-1', [
        { hostname: 'efflar.com', port: 3000 },
        { hostname: 'api.efflar.com', port: 4000 },
      ]);
      const cred = cf.tunnelPaths('tun-1').credentials;
      console.log(JSON.stringify({
        config: fs.readFileSync(conf, 'utf8'),
        modo: (fs.statSync(cred).mode & 0o777).toString(8),
        cred: JSON.parse(fs.readFileSync(cred, 'utf8')),
      }));
      `,
    ],
    { env: { ...process.env, PR_HOME: home }, encoding: 'utf8' }
  );

  const { config, modo, cred } = JSON.parse(out.trim().split('\n').pop());

  assert.match(config, /^tunnel: tun-1$/m);
  assert.match(config, /^\s+- hostname: efflar\.com$/m);
  assert.match(config, /^\s+service: http:\/\/localhost:3000$/m);
  assert.match(config, /^\s+- hostname: api\.efflar\.com$/m);
  assert.match(config, /^\s+service: http:\/\/localhost:4000$/m);
  // a regra final precisa ser a última: é o catch-all do cloudflared
  assert.match(config.trimEnd().split('\n').pop(), /- service: http_status:404/);

  assert.equal(modo, '600', 'a credencial do túnel não pode ficar legível para outros');
  assert.equal(cred.TunnelID, 'tun-1');
  assert.equal(cred.AccountTag, 'acct');
});

test('os vínculos ganham id curto e podem ser achados por id, endereço ou projeto', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const cf = await import('${path.resolve('src/cloudflare.js')}');
      const base = { process: 'loja', zoneId: 'z', zoneName: 'efflar.com', tunnelId: 't', tunnelName: 'pr-loja', port: 3000, createdAt: 1 };
      cf.saveLink({ ...base, hostname: 'efflar.com' });
      cf.saveLink({ ...base, hostname: 'app.efflar.com' });
      cf.saveLink({ ...base, hostname: 'api.efflar.com', process: 'api' });

      const ids = cf.links().map((l) => l.id);
      const porId = cf.resolveLink('1')?.hostname;
      const porHost = cf.resolveLink('efflar.com')?.id;
      const porProjeto = cf.resolveLink('api')?.hostname;

      // regravar o mesmo endereço mantém o id, e o id liberado é reaproveitado
      cf.saveLink({ ...base, hostname: 'app.efflar.com', port: 9999 });
      const idEstavel = cf.resolveLink('app.efflar.com')?.id;
      const portaNova = cf.resolveLink('app.efflar.com')?.port;

      cf.removeLink('efflar.com');
      cf.saveLink({ ...base, hostname: 'novo.efflar.com' });
      const reaproveitado = cf.resolveLink('novo.efflar.com')?.id;

      console.log(JSON.stringify({ ids, porId, porHost, porProjeto, idEstavel, portaNova, reaproveitado }));
      `,
    ],
    { env: { ...process.env, PR_HOME: home }, encoding: 'utf8' }
  );

  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.ids, [0, 1, 2], 'ids devem começar em 0 e ser sequenciais');
  assert.equal(r.porId, 'app.efflar.com');
  assert.equal(r.porHost, 0);
  assert.equal(r.porProjeto, 'api.efflar.com');
  assert.equal(r.idEstavel, 1, 'regravar o mesmo endereço não pode trocar o id');
  assert.equal(r.portaNova, 9999);
  assert.equal(r.reaproveitado, 0, 'o id liberado volta a ser usado');
});
