// `pr cloudflare` — publica um projeto num domínio via túnel da Cloudflare.
//
// Diferente do `pr register`, aqui o servidor não precisa de IP público,
// nem das portas 80/443 abertas: o cloudflared abre a conexão de dentro
// para fora e a Cloudflare cuida do certificado.

import fs from 'node:fs';
import * as store from './store.js';
import * as runner from './runner.js';
import * as cf from './cloudflare.js';
import * as cloudflared from './cloudflared.js';
import { select, ask, isInteractive } from './prompt.js';
import { c, box, tableLines, RULE, symbols, ok, info, warn, fail, truncate } from './ui.js';

export async function cmdCloudflare(args = []) {
  const acao = args[0];

  if (acao === 'kill' || acao === 'rm' || acao === 'delete' || acao === 'unlink')
    return desvincular(args.slice(1));
  if (acao === 'logout') return logout();
  if (acao === 'list' || acao === 'status') return listar();
  if (acao === 'sync') return sincronizar();
  if (acao === 'login') return login({ forcar: true });

  return conectar();
}

// ── credenciais ──────────────────────────────────────────────────────────

/**
 * Pega as credenciais guardadas ou pergunta por elas.
 * @returns {Promise<import('./cloudflare.js').Credenciais|null>}
 */
async function login({ forcar = false } = {}) {
  const guardadas = cf.credentials();

  if (guardadas && !forcar) {
    try {
      await cf.verify(guardadas);
      return guardadas;
    } catch (err) {
      fail(`a credencial guardada parou de funcionar: ${err.message}`);
      console.log(`  ${c.faint('vamos pedir de novo')}`);
      console.log();
    }
  }

  if (!isInteractive()) {
    fail('sem credencial da Cloudflare. Rode `pr cloudflare login` num terminal');
    return null;
  }

  console.log();
  console.log(
    box(
      [
        `${c.text('Crie um API Token em:')}`,
        `${c.accent('https://dash.cloudflare.com/profile/api-tokens')}`,
        '',
        `${c.dim('Use o modelo')} ${c.text('"Create Custom Token"')} ${c.dim('com estas permissões:')}`,
        `  ${c.text('Account')}  ${c.dim('· Cloudflare Tunnel · Edit')}`,
        `  ${c.text('Zone')}     ${c.dim('· DNS · Edit')}`,
        `  ${c.text('Zone')}     ${c.dim('· Zone · Read')}`,
      ],
      { title: 'acesso à sua conta Cloudflare' }
    )
  );
  console.log();

  const modo = await select(
    [
      { label: 'API Token', hint: 'recomendado — permissões limitadas ao necessário', value: 'token' },
      { label: 'Global API Key', hint: 'acesso total à conta; use só se preferir', value: 'global' },
      { label: c.faint('cancelar'), hint: '', value: null },
    ],
    { title: 'como quer conectar?' }
  );
  if (!modo) return null;

  let creds;
  if (modo === 'token') {
    const token = await ask('cole o API Token:', { placeholder: 'enter para cancelar' });
    if (!token) return null;
    creds = { mode: 'token', token: token.trim() };
  } else {
    const email = await ask('e-mail da conta Cloudflare:', { placeholder: 'enter para cancelar' });
    if (!email) return null;
    const key = await ask('cole a Global API Key:', { placeholder: 'enter para cancelar' });
    if (!key) return null;
    creds = { mode: 'global', email: email.trim(), key: key.trim() };
  }

  console.log();
  try {
    const quem = await cf.verify(creds);
    ok(`conectado à Cloudflare ${c.faint(`(${quem})`)}`);
  } catch (err) {
    fail(`não consegui entrar: ${err.message}`);
    console.log();
    return null;
  }

  // uma conta só é o caso comum; mais de uma, o usuário escolhe
  const contas = await cf.accounts(creds);
  if (!contas.length) {
    fail('essa credencial não enxerga nenhuma conta');
    return null;
  }

  let conta = contas[0];
  if (contas.length > 1 && isInteractive()) {
    console.log();
    const escolhida = await select(
      contas.map((a) => ({ label: a.name, hint: a.id, value: a })),
      { title: 'qual conta?' }
    );
    if (!escolhida) return null;
    conta = escolhida;
  }

  creds.accountId = conta.id;
  creds.accountName = conta.name;
  cf.saveCredentials(creds);

  ok(`conta ${c.text(conta.name)} ${c.faint('guardada em ~/.pr/cloudflare.json')}`);
  console.log();
  return creds;
}

function logout() {
  console.log();
  cf.forgetCredentials();
  ok('credencial da Cloudflare removida');
  console.log(`  ${c.faint('os túneis já criados continuam rodando; veja com pr list')}`);
  console.log();
}

// ── fluxo principal ──────────────────────────────────────────────────────

async function conectar() {
  const creds = await login();
  if (!creds) return;

  const rodando = store
    .list()
    .map(runner.inspect)
    .filter((p) => p.status === 'online');

  if (!rodando.length) {
    info('nenhum projeto no ar para publicar. Suba um com `pr npm run dev`');
    console.log();
    return;
  }

  if (!isInteractive()) {
    fail('esta parte é interativa — rode `pr cloudflare` num terminal');
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
    { title: 'qual projeto quer publicar?' }
  );
  if (!projeto) return;

  const porta = projeto.ports[0];
  if (!porta) {
    fail(`não descobri em que porta "${projeto.name}" escuta — o túnel precisa dela`);
    console.log(`  ${c.faint(`confira com: pr info ${projeto.name}`)}`);
    console.log();
    return;
  }

  console.log();
  info('buscando seus domínios na Cloudflare…');
  let zonas;
  try {
    zonas = await cf.zones(creds, creds.accountId);
  } catch (err) {
    fail(`não consegui listar os domínios: ${err.message}`);
    console.log();
    return;
  }

  if (!zonas.length) {
    fail('nenhum domínio ativo nesta conta da Cloudflare');
    console.log(`  ${c.faint('adicione o domínio no painel da Cloudflare primeiro')}`);
    console.log();
    return;
  }

  const zona = await select(
    [
      ...zonas.map((z) => ({ label: z.name, hint: z.status, value: z })),
      { label: c.faint('cancelar'), hint: '', value: null },
    ],
    { title: 'em qual domínio?' }
  );
  if (!zona) return;

  const hostname = await perguntarHostname(zona.name);
  if (!hostname) return;

  console.log();
  await publicar({ creds, projeto, porta, zona, hostname });
}

/**
 * Limpa o que o usuário digitou e confere se o endereço pertence à zona.
 * @returns {{hostname:string}|{erro:string}}
 */
export function validarHostname(zoneName, entrada) {
  const limpo = String(entrada ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');

  if (!limpo) return { erro: 'endereço vazio' };
  if (limpo !== zoneName && !limpo.endsWith(`.${zoneName}`)) {
    return { erro: `"${limpo}" não pertence a ${zoneName}` };
  }
  return { hostname: limpo };
}

/** Aceita o domínio raiz ou um subdomínio dele. */
async function perguntarHostname(zoneName) {
  const resposta = await ask('endereço (enter usa o domínio raiz):', { defaultValue: zoneName });
  if (resposta === null) return null;

  const resultado = validarHostname(zoneName, resposta);
  if (resultado.erro) {
    console.log();
    fail(resultado.erro);
    console.log(`  ${c.faint(`use ${zoneName} ou algo como app.${zoneName}`)}`);
    console.log();
    return null;
  }
  return resultado.hostname;
}

/** Cria o túnel, aponta o DNS e sobe o cloudflared. */
async function publicar({ creds, projeto, porta, zona, hostname }) {
  const passo = (msg) => console.log(`  ${c.accent(symbols.arrow)} ${c.dim(msg)}`);

  try {
    const binario = await cloudflared.ensure((msg) => passo(msg));

    // um túnel por projeto: republicar o mesmo projeto reaproveita
    const nomeTunel = `pr-${projeto.name}`;
    const existentes = await cf.tunnels(creds, creds.accountId);
    const anterior = existentes.find((t) => t.name === nomeTunel);

    let tunelId;
    let segredo = null;

    if (anterior && temCredencialLocal(anterior.id)) {
      tunelId = anterior.id;
      passo(`reaproveitando o túnel ${nomeTunel}`);
    } else {
      if (anterior) {
        // existe na Cloudflare mas perdemos o segredo: recriar é o caminho
        passo(`recriando o túnel ${nomeTunel} (credencial local ausente)`);
        await cf.deleteTunnel(creds, creds.accountId, anterior.id);
      } else {
        passo(`criando o túnel ${nomeTunel}`);
      }
      const novo = await cf.createTunnel(creds, creds.accountId, nomeTunel);
      tunelId = novo.id;
      segredo = novo.secret;
    }

    if (segredo) {
      cf.writeTunnelCredentials({
        accountId: creds.accountId,
        tunnelId: tunelId,
        tunnelName: nomeTunel,
        secret: segredo,
      });
    }

    // todas as rotas deste túnel, para o config não perder as anteriores
    const rotas = [
      ...cf.links().filter((l) => l.tunnelId === tunelId && l.hostname !== hostname),
      { hostname, port: porta },
    ].map((l) => ({ hostname: l.hostname, port: l.port }));

    const config = cf.writeTunnelConfig(tunelId, rotas);
    passo(`configuração escrita em ${config.replace(process.env.HOME || '', '~')}`);

    passo(`apontando ${hostname} para o túnel`);
    const registro = await cf.pointToTunnel(creds, zona.id, hostname, tunelId);

    cf.saveLink({
      recordId: registro?.id,
      process: projeto.name,
      hostname,
      zoneId: zona.id,
      zoneName: zona.name,
      tunnelId: tunelId,
      tunnelName: nomeTunel,
      port: porta,
      createdAt: Date.now(),
    });

    // o túnel roda como um processo do próprio pr: aparece no pr list,
    // reinicia sozinho se cair e para com pr stop
    const nomeProcesso = cf.tunnelProcessName(projeto.name);
    const anteriorProc = store.read(nomeProcesso);
    if (anteriorProc) {
      passo('reiniciando o conector');
      await runner.stop(anteriorProc);
    } else {
      passo('subindo o conector');
    }

    runner.start(`${binario} tunnel --config ${config} --no-autoupdate run`, {
      cwd: process.env.HOME || '/',
      name: nomeProcesso,
    });

    const estado = await esperarConector(nomeProcesso);

    console.log();
    if (estado === 'conectado') {
      ok(
        `${c.accent(c.underline(`https://${hostname}`))} ${c.faint('→')} ${c.text(projeto.name)} ${c.faint(`(porta ${porta})`)}`
      );
      console.log(`  ${c.faint('a Cloudflare cuida do certificado — pode levar um minuto para o dns propagar')}`);
      console.log(`  ${c.faint(`conector: pr logs ${nomeProcesso} -f   ·   túneis: pr cloudflare list`)}`);
    } else if (estado === 'tentando') {
      warn(`o conector subiu mas ainda não registrou a conexão com a Cloudflare`);
      console.log(`  ${c.faint(`ele segue tentando; acompanhe com: pr logs ${nomeProcesso} -f`)}`);
      console.log(`  ${c.faint('credencial recusada e rede bloqueada são as causas comuns')}`);
    } else {
      fail('o conector não ficou de pé');
      console.log(`  ${c.faint(`veja o motivo: pr logs ${nomeProcesso}`)}`);
      process.exitCode = 1;
    }
    console.log();
  } catch (err) {
    console.log();
    fail(err.message);
    console.log();
    process.exitCode = 1;
  }
}

function temCredencialLocal(tunnelId) {
  return fs.existsSync(cf.tunnelPaths(tunnelId).credentials);
}

/**
 * Estado real do conector, lido do log — o cloudflared não abre porta,
 * e continuar de pé não significa que a Cloudflare aceitou a credencial:
 * ele fica em laço de reconexão.
 * @returns {'conectado'|'tentando'|'parado'}
 */
function estadoConector(nomeProcesso) {
  const proc = store.read(nomeProcesso);
  if (!proc || !runner.liveStatus(proc).alive) return 'parado';

  const log = runner.tailText(nomeProcesso, 16000);
  const registrou = log.lastIndexOf('Registered tunnel connection');
  const falhou = Math.max(
    log.lastIndexOf('Serve tunnel error'),
    log.lastIndexOf('failed to serve tunnel connection'),
    log.lastIndexOf('Unauthorized')
  );

  if (registrou === -1) return 'tentando';
  return registrou > falhou ? 'conectado' : 'tentando';
}

/** Espera o conector registrar a conexão com a borda da Cloudflare. */
async function esperarConector(nomeProcesso, { timeoutMs = 25000 } = {}) {
  const limite = Date.now() + timeoutMs;
  const fatal = /error parsing tunnel ID|Unauthorized|failed to create|error parsing/i;

  while (Date.now() < limite) {
    const estado = estadoConector(nomeProcesso);
    if (estado === 'conectado') return 'conectado';
    if (estado === 'parado') return 'parado';
    if (fatal.test(runner.tailText(nomeProcesso, 8000))) return 'parado';
    await new Promise((r) => setTimeout(r, 500));
  }

  return estadoConector(nomeProcesso);
}


/**
 * Desfaz o vínculo entre um domínio e um projeto: tira o registro DNS,
 * a rota do túnel e, se ninguém mais usava aquele túnel, apaga o túnel
 * e para o conector.
 */
async function desvincular(args) {
  if (!args.length) {
    fail('informe o id, o endereço ou o projeto. Ex.: pr cloudflare kill 0');
    console.log(`  ${c.faint('veja os ids com: pr cloudflare list')}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  for (const alvo of args) {
    const link = cf.resolveLink(alvo);
    if (!link) {
      fail(`"${alvo}" não está na lista (pr cloudflare list)`);
      process.exitCode = 1;
      continue;
    }

    const passo = (msg) => console.log(`  ${c.accent(symbols.arrow)} ${c.dim(msg)}`);
    const creds = cf.credentials();

    // o DNS é o que realmente tira o domínio do ar; sem credencial, avisa
    if (creds) {
      try {
        const apagou = await cf.unpointFromTunnel(creds, link.zoneId, link.hostname, link.recordId);
        passo(apagou ? `registro de ${link.hostname} removido da Cloudflare` : `${link.hostname} já não tinha registro`);
      } catch (err) {
        warn(`não consegui apagar o registro DNS: ${err.message}`);
        console.log(`  ${c.faint('apague na Cloudflare para o domínio parar de responder')}`);
      }
    } else {
      warn('sem credencial guardada — o registro DNS continua na Cloudflare');
    }

    const irmaos = cf.links().filter((l) => l.tunnelId === link.tunnelId && l.hostname !== link.hostname);
    const nomeProcesso = cf.tunnelProcessName(link.process);
    const conector = store.read(nomeProcesso);

    if (irmaos.length) {
      // o túnel ainda serve outros endereços: só some a rota
      cf.writeTunnelConfig(link.tunnelId, irmaos.map((l) => ({ hostname: l.hostname, port: l.port })));
      if (conector) {
        await runner.restart(conector);
        passo(`conector reiniciado sem ${link.hostname}`);
      }
    } else {
      if (conector) {
        await runner.stop(conector);
        store.remove(nomeProcesso);
        passo(`conector ${nomeProcesso} parado`);
      }
      if (creds?.accountId) {
        try {
          await cf.deleteTunnel(creds, creds.accountId, link.tunnelId);
          passo(`túnel ${link.tunnelName} apagado`);
        } catch (err) {
          warn(`o túnel ${link.tunnelName} ficou na Cloudflare: ${err.message}`);
        }
      }
      cf.removeTunnelFiles(link.tunnelId);
    }

    cf.removeLink(link.hostname);
    ok(`${c.text(link.hostname)} ${c.faint('desvinculado de')} ${c.text(link.process)}`);
  }
  console.log();
}

// ── listagem e manutenção ────────────────────────────────────────────────

function listar() {
  const vinculos = cf.links();

  console.log();
  if (!vinculos.length) {
    console.log(
      box([`${c.faint('nenhum túnel ainda. Rode')} ${c.accent('pr cloudflare')} ${c.faint('para criar um.')}`], {
        title: 'cloudflare',
      })
    );
    console.log();
    return;
  }

  const linhas = vinculos.map((l) => {
    const proc = store.read(l.process);
    const vivo = proc ? runner.inspect(proc) : null;
    const conector = estadoConector(cf.tunnelProcessName(l.process));
    const projetoNoAr = vivo?.status === 'online';

    let bolinha = c.red(symbols.bullet);
    let situacao = `${l.process} fora do ar`;
    let cor = c.faint;

    if (projetoNoAr && conector === 'conectado') {
      bolinha = c.green(symbols.bullet);
      situacao = 'conectado';
      cor = c.green;
    } else if (projetoNoAr && conector === 'tentando') {
      bolinha = c.yellow(symbols.bullet);
      situacao = 'conector tentando conectar';
      cor = c.yellow;
    } else if (projetoNoAr) {
      situacao = 'conector parado';
    }

    return {
      id: c.faint(String(l.id ?? '—')),
      host: `${bolinha} ${c.text(truncate(l.hostname, 30))}`,
      projeto: c.dim(l.process),
      porta: c.accent(String(l.port)),
      situacao: cor(situacao),
    };
  });

  const [cabecalho, ...corpo] = tableLines(
    [
      { key: 'id', label: 'id', align: 'right' },
      { key: 'host', label: 'endereço' },
      { key: 'projeto', label: 'projeto' },
      { key: 'porta', label: 'porta', align: 'right' },
      { key: 'situacao', label: 'situação' },
    ],
    linhas,
    { indent: '' }
  );

  const creds = cf.credentials();
  const rodape = creds
    ? c.faint(`conta ${creds.accountName || creds.accountId || '—'}  ·  desvincular: pr cloudflare kill <id>`)
    : c.yellow('sem credencial — pr cloudflare login');

  console.log(box([cabecalho, RULE, ...corpo, RULE, rodape], { title: 'cloudflare' }));
  console.log();
}

/**
 * Reescreve os configs com as portas atuais e reinicia os conectores.
 * Útil quando um projeto voltou numa porta diferente.
 */
async function sincronizar() {
  const vinculos = cf.links();
  console.log();

  if (!vinculos.length) {
    info('nenhum túnel para sincronizar');
    console.log();
    return;
  }

  const porTunel = new Map();
  const mudou = new Set();

  for (const link of vinculos) {
    const proc = store.read(link.process);
    const vivo = proc ? runner.inspect(proc) : null;
    const porta = vivo?.ports[0] ?? link.port;

    if (porta !== link.port) {
      info(`${c.text(link.hostname)}: porta ${link.port} → ${c.accent(String(porta))}`);
      cf.saveLink({ ...link, port: porta });
      mudou.add(link.tunnelId);
    }

    const rotas = porTunel.get(link.tunnelId) || [];
    rotas.push({ hostname: link.hostname, port: porta });
    porTunel.set(link.tunnelId, rotas);
  }

  for (const [tunnelId, rotas] of porTunel) {
    cf.writeTunnelConfig(tunnelId, rotas);
  }

  if (!mudou.size) {
    ok('tudo já estava em dia');
    console.log();
    return;
  }

  for (const link of vinculos) {
    if (!mudou.has(link.tunnelId)) continue;
    const nome = cf.tunnelProcessName(link.process);
    const proc = store.read(nome);
    if (proc) {
      await runner.restart(proc);
      ok(`conector ${c.text(nome)} reiniciado`);
    }
  }
  console.log();
}
