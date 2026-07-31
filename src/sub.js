// `pr sub` — cria um subdomínio de um domínio já publicado, apontando
// para outro projeto (ou para o mesmo, noutra porta).
//
// Funciona nos dois caminhos de publicação: no proxy próprio o vínculo
// entra em domains.json e o certificado sai quando o DNS apontar; no
// túnel da Cloudflare o registro e a rota são criados na hora.

import * as store from './store.js';
import * as runner from './runner.js';
import * as domains from './domains.js';
import * as cf from './cloudflare.js';
import * as proxyctl from './proxyctl.js';
import { publicar as publicarNoTunel, login as loginCloudflare } from './cftunnel.js';
import { publicIp } from './net.js';
import { select, ask, isInteractive } from './prompt.js';
import { c, box, tableLines, ok, info, warn, fail } from './ui.js';

/**
 * Um rótulo de subdomínio: só o pedaço da frente, sem pontos.
 * @returns {{label:string}|{erro:string}}
 */
export function validarRotulo(entrada) {
  const limpo = String(entrada ?? '').trim().toLowerCase().replace(/\.$/, '');

  if (!limpo) return { erro: 'o subdomínio não pode ficar em branco' };
  if (limpo.includes('.')) {
    return { erro: `digite só o começo, sem pontos — "app", não "${limpo}"` };
  }
  if (limpo.length > 63) return { erro: 'no máximo 63 caracteres' };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(limpo)) {
    return { erro: `"${limpo}" só pode ter letras, números e hífen no meio` };
  }
  return { label: limpo };
}

/**
 * Tudo que já está publicado, dos dois caminhos, numa lista só.
 * @param {'proxy'|'tunel'} [apenas] restringe a um dos caminhos
 */
function publicados(apenas) {
  const doProxy = domains.all().map((b) => {
    const proc = store.read(b.process);
    const vivo = proc ? runner.inspect(proc) : null;
    return {
      tipo: 'proxy',
      hostname: b.domain,
      processo: b.process,
      porta: vivo?.ports[0] ?? null,
      binding: b,
    };
  });

  const doTunel = cf.links().map((l) => ({
    tipo: 'tunel',
    hostname: l.hostname,
    processo: l.process,
    porta: l.port,
    link: l,
  }));

  const todos = apenas === 'proxy' ? doProxy : apenas === 'tunel' ? doTunel : [...doProxy, ...doTunel];
  return todos.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/**
 * @param {string[]} args
 * @param {{apenas?:'proxy'|'tunel'}} [opcoes] `apenas: 'tunel'` é o que o
 *   `pr cloudflare sub` usa, para não misturar com os domínios do proxy
 */
export async function cmdSub(args = [], { apenas } = {}) {
  const lista = publicados(apenas);

  console.log();
  if (!lista.length) {
    fail(
      apenas === 'tunel'
        ? 'nenhum domínio publicado por túnel ainda'
        : 'nenhum domínio publicado ainda'
    );
    console.log(
      apenas === 'tunel'
        ? `  ${c.faint('publique um primeiro com')} ${c.accent('pr cloudflare')}`
        : `  ${c.faint('publique um primeiro com')} ${c.accent('pr register')} ${c.faint('ou')} ${c.accent('pr cloudflare')}`
    );
    console.log();
    process.exitCode = 1;
    return;
  }

  if (!isInteractive()) {
    fail('esta parte é interativa — rode `pr sub` num terminal');
    process.exitCode = 1;
    return;
  }

  const pai = await select(
    [
      ...lista.map((d) => ({
        label: d.hostname,
        hint: `${d.processo}${d.porta ? ` · porta ${d.porta}` : ''}  ${d.tipo === 'tunel' ? 'túnel' : 'proxy'}`,
        value: d,
      })),
      { label: c.faint('cancelar'), hint: '', value: null },
    ],
    { title: 'de qual domínio quer criar um subdomínio?' }
  );
  if (!pai) return;

  const resposta = await ask(`subdomínio de ${pai.hostname}:`, { placeholder: 'ex.: app' });
  if (resposta === null) return;

  const rotulo = validarRotulo(resposta);
  if (rotulo.erro) {
    console.log();
    fail(rotulo.erro);
    console.log();
    process.exitCode = 1;
    return;
  }

  const hostname = `${rotulo.label}.${pai.hostname}`;

  const jaExiste =
    domains.get(hostname) || cf.links().find((l) => l.hostname === hostname);
  if (jaExiste) {
    console.log();
    const alvo = jaExiste.process ?? jaExiste.processo;
    info(`${hostname} já existe, apontando para ${c.text(alvo)} — vou trocar o destino`);
  }

  const rodando = store
    .list()
    .map(runner.inspect)
    .filter((p) => p.status === 'online');

  if (!rodando.length) {
    console.log();
    fail('nenhum projeto no ar para atender o subdomínio');
    console.log(`  ${c.faint('suba um com: pr npm run dev')}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  const projeto = await select(
    [
      ...rodando.map((p) => ({
        label: p.name,
        hint: `porta ${p.ports[0] ?? '—'}`,
        value: p,
      })),
      { label: c.faint('cancelar'), hint: '', value: null },
    ],
    { title: `qual projeto vai responder em ${hostname}?` }
  );
  if (!projeto) return;

  const porta = projeto.ports[0];
  if (!porta) {
    console.log();
    fail(`não descobri em que porta "${projeto.name}" escuta`);
    console.log(`  ${c.faint(`confira com: pr info ${projeto.name}`)}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  if (pai.tipo === 'tunel') return criarNoTunel({ pai, hostname, projeto, porta });
  return criarNoProxy({ hostname, projeto, porta });
}

/** Caminho do túnel: registro e rota são criados na hora, via API. */
async function criarNoTunel({ pai, hostname, projeto, porta }) {
  const creds = await loginCloudflare();
  if (!creds) return;

  await publicarNoTunel({
    creds,
    projeto,
    porta,
    zona: { id: pai.link.zoneId, name: pai.link.zoneName },
    hostname,
  });
}

/** Caminho do proxy: o vínculo é local, o registro A é com o usuário. */
async function criarNoProxy({ hostname, projeto, porta }) {
  domains.add({ domain: hostname, process: projeto.name, www: false });

  ok(
    `${c.text(hostname)} ${c.faint('→')} ${c.text(projeto.name)} ${c.faint(`(porta ${porta})`)}`
  );
  console.log();

  const { ip, source } = await publicIp();
  const rotulo = hostname.slice(0, hostname.indexOf('.'));

  const [cabecalho, linha] = tableLines(
    [
      { key: 'tipo', label: 'tipo' },
      { key: 'nome', label: 'nome' },
      { key: 'valor', label: 'valor' },
      { key: 'ttl', label: 'ttl', align: 'right' },
    ],
    [{ tipo: c.text('A'), nome: c.text(rotulo), valor: c.accent(ip || '?'), ttl: c.dim('3600') }],
    { indent: '' }
  );

  console.log(
    box(
      [
        c.dim('Na zona DNS do domínio, acrescente:'),
        '',
        cabecalho,
        linha,
        ...(source === 'local' ? ['', c.yellow(`! ${ip} é um IP de rede local`)] : []),
      ],
      { title: `aponte ${hostname} para cá` }
    )
  );
  console.log();

  const proxy = proxyctl.status();
  if (!proxy.running) {
    warn('o proxy está parado — suba com: pr proxy start');
  } else {
    info('assim que o DNS propagar, o certificado sai sozinho');
  }
  console.log(`  ${c.faint('confira com: pr register   ·   detalhes: pr proxy logs')}`);
  console.log();
}
