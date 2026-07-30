// Interface de linha de comando do `pr`.

import fs from 'node:fs';
import * as store from './store.js';
import * as runner from './runner.js';
import * as domainsCli from './register.js';
import { cmdMenu, isMenuAvailable } from './menu.js';
import { cmdCloudflare } from './cftunnel.js';
import { startAndReport, shortenPath } from './start.js';
import { c, tableLines, box, RULE, symbols, statusDot, ok, info, fail, since, bytes, truncate } from './ui.js';

const VERSION = '0.1.0';

const KNOWN = new Set([
  'start', 'list', 'ls', 'status', 'stop', 'kill', 'restart', 'logs', 'log',
  'info', 'show', 'delete', 'rm', 'del', 'help', 'clean',
  'register', 'domains', 'unregister', 'unlink', 'proxy', 'menu',
  'cloudflare', 'cf',
]);

export async function main(argv) {
  const [first, ...rest] = argv;

  if (!first) return isMenuAvailable() ? cmdMenu() : help();
  if (first === 'help' || first === '--help' || first === '-h') return help();
  if (first === 'menu') return cmdMenu();
  if (first === '--version' || first === '-v') return console.log(`pr ${VERSION}`);

  // qualquer coisa que não seja subcomando conhecido é o comando a rodar:
  //   pr npm run dev
  if (!KNOWN.has(first)) return cmdStart(argv);

  switch (first) {
    case 'start':
      return cmdStart(rest);
    case 'list':
    case 'ls':
    case 'status':
      return cmdList();
    case 'stop':
    case 'kill':
      return cmdStop(rest);
    case 'restart':
      return cmdRestart(rest);
    case 'logs':
    case 'log':
      return cmdLogs(rest);
    case 'info':
    case 'show':
      return cmdInfo(rest);
    case 'delete':
    case 'rm':
    case 'del':
      return cmdDelete(rest);
    case 'clean':
      return cmdClean();
    case 'register':
    case 'domains':
      return domainsCli.cmdRegister();
    case 'unregister':
    case 'unlink':
      return domainsCli.cmdUnregister(rest);
    case 'proxy':
      return domainsCli.cmdProxy(rest);
    case 'cloudflare':
    case 'cf':
      return cmdCloudflare(rest);
    default:
      return help();
  }
}

/** Extrai flags conhecidas, devolvendo o resto intacto. */
function parseFlags(args, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = spec[arg];
    if (key) {
      flags[key.name] = key.boolean ? true : args[++i];
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

async function cmdStart(args) {
  const { flags, rest } = parseFlags(args, {
    '--name': { name: 'name' },
    '-n': { name: 'name' },
    '--cwd': { name: 'cwd' },
  });

  if (!rest.length) {
    fail('nada para rodar. Ex.: pr npm run dev');
    process.exitCode = 1;
    return;
  }

  const command = rest.length === 1 ? rest[0] : rest.map(quote).join(' ');
  await startAndReport({ command, cwd: flags.cwd, name: flags.name });
}

function cmdList() {
  const procs = store.list().map(runner.inspect);

  console.log();
  if (!procs.length) {
    console.log(
      box([`${c.faint('nada rodando. Rode')} ${c.accent('pr npm run dev')} ${c.faint('em um projeto.')}`], {
        title: 'processos',
      })
    );
    console.log();
    return;
  }

  const rows = procs.map((p) => ({
    id: c.faint(String(p.id)),
    name: `${statusDot(p.status)} ${c.text(p.name)}`,
    status: colorStatus(p.status),
    port: p.ports.length ? c.accent(p.ports.join(', ')) : c.faint('—'),
    uptime: p.alive && p.startedAt ? c.dim(since(p.startedAt)) : c.faint('—'),
    mem: p.alive ? c.dim(bytes(p.memory)) : c.faint('—'),
    restarts: p.restarts ? c.yellow(String(p.restarts)) : c.faint('0'),
    command: c.faint(truncate(p.command, 28)),
  }));

  const [header, ...body] = tableLines(
    [
      { key: 'id', label: 'id', align: 'right' },
      { key: 'name', label: 'nome' },
      { key: 'status', label: 'status' },
      { key: 'port', label: 'porta' },
      { key: 'uptime', label: 'no ar', align: 'right' },
      { key: 'mem', label: 'mem', align: 'right' },
      { key: 'restarts', label: 'restarts', align: 'right' },
      { key: 'command', label: 'comando' },
    ],
    rows,
    { indent: '' }
  );

  const online = procs.filter((p) => p.status === 'online').length;
  const summary = c.faint(`${online} no ar · ${procs.length - online} fora do ar`);

  console.log(box([header, RULE, ...body, RULE, summary], { title: 'processos' }));
  console.log();
}

async function eachTarget(args, label, fn) {
  const targets = args.includes('all') || args.includes('--all') ? store.list() : args.map(pick).filter(Boolean);

  if (!args.length) {
    fail(`informe um nome, id ou "all". Ex.: pr ${label} api`);
    process.exitCode = 1;
    return;
  }
  if (!targets.length) {
    process.exitCode = 1;
    return;
  }

  console.log();
  for (const proc of targets) await fn(proc);
  console.log();
}

function pick(target) {
  try {
    const proc = store.resolve(target);
    if (!proc) {
      fail(`"${target}" não encontrado (pr list)`);
      process.exitCode = 1;
      return null;
    }
    return proc;
  } catch (err) {
    fail(err.message);
    process.exitCode = 1;
    return null;
  }
}

function cmdStop(args) {
  return eachTarget(args, 'stop', async (proc) => {
    await runner.stop(proc);
    ok(`${c.text(proc.name)} ${c.faint('parado')}`);
  });
}

function cmdRestart(args) {
  return eachTarget(args, 'restart', async (proc) => {
    const next = await runner.restart(proc);
    const port = await runner.waitForPort(next.name, { timeoutMs: 8000 });
    ok(
      `${c.text(next.name)} ${c.faint('reiniciado')}` +
        (port ? ` ${c.accent(`http://localhost:${port}`)}` : '')
    );
  });
}

function cmdDelete(args) {
  return eachTarget(args, 'delete', async (proc) => {
    await runner.stop(proc);
    store.remove(proc.name);
    fs.rmSync(store.logFile(proc.name), { force: true });
    fs.rmSync(store.errFile(proc.name), { force: true });
    ok(`${c.text(proc.name)} ${c.faint('removido')}`);
  });
}

function cmdClean() {
  const gone = store.list().map(runner.inspect).filter((p) => !p.alive);
  console.log();
  if (!gone.length) {
    info('nada para limpar');
    console.log();
    return;
  }
  for (const proc of gone) {
    store.remove(proc.name);
    fs.rmSync(store.logFile(proc.name), { force: true });
    fs.rmSync(store.errFile(proc.name), { force: true });
    ok(`${c.text(proc.name)} ${c.faint('removido')}`);
  }
  console.log();
}

function cmdInfo(args) {
  const proc = args.length && pick(args[0]);
  if (!proc) {
    if (!args.length) fail('informe um nome ou id. Ex.: pr info api');
    process.exitCode = 1;
    return;
  }

  const p = runner.inspect(proc);
  const rows = [
    ['status', colorStatus(p.status)],
    ['id', String(p.id)],
    ['pid', p.pid ? String(p.pid) : '—'],
    ['comando', p.command],
    ['pasta', shortenPath(p.cwd, 60)],
    ['portas', p.ports.length ? p.ports.map((n) => `http://localhost:${n}`).join(' ') : '—'],
    ['no ar', p.alive && p.startedAt ? since(p.startedAt) : '—'],
    ['memória', p.alive ? bytes(p.memory) : '—'],
    ['restarts', String(p.restarts ?? 0)],
    ['saída', p.exitCode === null || p.exitCode === undefined ? '—' : String(p.exitCode)],
    ['log', shortenPath(store.logFile(p.name), 60)],
  ];

  const label = Math.max(...rows.map(([k]) => k.length));
  console.log();
  console.log(
    box(
      rows.map(([k, v]) => `${c.dim(k.padEnd(label))}  ${c.text(v)}`),
      { title: p.name }
    )
  );
  console.log();
}

function cmdLogs(args) {
  const { flags, rest } = parseFlags(args, {
    '-f': { name: 'follow', boolean: true },
    '--follow': { name: 'follow', boolean: true },
    '-n': { name: 'lines' },
    '--lines': { name: 'lines' },
  });

  const proc = rest.length ? pick(rest[0]) : null;
  if (!proc) {
    if (!rest.length) fail('informe um nome ou id. Ex.: pr logs api -f');
    process.exitCode = 1;
    return;
  }

  const count = Number(flags.lines) || 30;
  const file = store.logFile(proc.name);
  const text = runner.tailText(proc.name);
  const lines = text.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - count - 1));

  console.log();
  console.log(`  ${c.faint(`${proc.name} · últimas ${count} linhas`)}`);
  console.log();
  for (const line of tail) console.log(line);

  if (!flags.follow) return;

  let position = fs.existsSync(file) ? fs.statSync(file).size : 0;
  console.log(c.faint(`\n  seguindo… (ctrl+c para sair)\n`));

  fs.watchFile(file, { interval: 250 }, (curr) => {
    if (curr.size < position) position = 0; // log truncado por um restart
    if (curr.size === position) return;
    const stream = fs.createReadStream(file, { start: position, end: curr.size - 1 });
    position = curr.size;
    stream.on('data', (chunk) => process.stdout.write(chunk));
  });

  return new Promise(() => {}); // segura até ctrl+c
}

function colorStatus(status) {
  if (status === 'online') return c.green(status);
  if (status === 'errored') return c.red(status);
  if (status === 'stopped') return c.faint(status);
  return c.yellow(status);
}

function quote(arg) {
  return /[\s"'$`\\|&;<>()*?[\]{}!#~]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

function help() {
  const section = (title) => `\n  ${c.faint(title)}\n`;
  const cmd = (name, desc, { width = 32 } = {}) =>
    `    ${c.accent(name.padEnd(width))} ${c.dim(desc)}`;

  const out = [
    '',
    `  ${c.bold(c.accent('pr'))} ${c.faint(`v${VERSION}`)} ${c.dim('— rode seus projetos em segundo plano e publique num domínio')}`,
    section('USO'),
    cmd('pr', 'abre o menu: registrar domínio, rodar projeto…'),
    cmd('pr <comando...>', 'roda o comando na pasta atual, em segundo plano'),
    cmd('pr <subcomando> [alvo]', 'os subcomandos abaixo'),
    `\n  ${c.faint('O alvo de qualquer subcomando pode ser o nome, o id ou um prefixo:')}`,
    `  ${c.faint('pr stop api · pr stop 0 · pr logs ap · pr restart all')}`,
    section('RODAR'),
    cmd('pr npm run dev', 'sobe o projeto da pasta atual; o nome vem da pasta'),
    cmd('pr python3 -m http.server 3000', 'funciona com qualquer comando, não só npm'),
    cmd('pr start "<cmd>" -n api', 'nome escolhido; use aspas se tiver && | >'),
    cmd('pr start "<cmd>" --cwd <pasta>', 'roda em outra pasta'),
    section('ACOMPANHAR'),
    cmd('pr list', 'o que está rodando: porta, uptime, memória, restarts'),
    cmd('pr info <alvo>', 'tudo de um processo, incluindo o caminho do log'),
    cmd('pr logs <alvo>', 'as últimas 30 linhas do log'),
    cmd('pr logs <alvo> -f', 'acompanha o log ao vivo (ctrl+c para sair)'),
    cmd('pr logs <alvo> -n 100', 'quantas linhas mostrar'),
    section('CONTROLAR'),
    cmd('pr restart <alvo|all>', 'para e sobe de novo, com o mesmo comando'),
    cmd('pr stop <alvo|all>', 'para, mas mantém na lista como stopped'),
    cmd('pr kill <alvo|all>', 'o mesmo que stop'),
    cmd('pr delete <alvo|all>', 'para, tira da lista e apaga os logs'),
    cmd('pr clean', 'apaga da lista tudo que já está parado'),
    section('DOMÍNIOS'),
    cmd('pr register', 'escolhe um projeto, pede o domínio e mostra o DNS'),
    cmd('pr domains', 'só a lista dos domínios e a situação de cada um'),
    cmd('pr unregister <dominio>', 'desliga o domínio e apaga o certificado'),
    cmd('pr proxy status', 'o proxy está no ar? em que ip e portas?'),
    cmd('pr proxy start', 'sobe o proxy das portas 80 e 443'),
    cmd('pr proxy stop', 'derruba o proxy'),
    cmd('pr proxy logs [-f] [n]', "o que o proxy e o Let's Encrypt andam fazendo"),
    '',
    cmd('pr cloudflare', 'publica por túnel da Cloudflare (sem IP público)'),
    cmd('pr cloudflare list', 'os túneis criados e a situação de cada um'),
    cmd('pr cloudflare sync', 'reescreve os túneis com as portas atuais'),
    cmd('pr cloudflare login|logout', 'troca ou remove a credencial da conta'),
    `\n  ${c.faint('Na lista de domínios a bolinha diz o que falta:')}`,
    `  ${c.red(symbols.bullet)} ${c.faint('o DNS ainda não aponta para cá, ou o projeto caiu')}`,
    `  ${c.yellow(symbols.bullet)} ${c.faint('DNS certo, certificado a caminho (ou um aviso a resolver)')}`,
    `  ${c.green(symbols.bullet)} ${c.faint('pronto, servindo em https')}`,
    section('OUTROS'),
    cmd('pr help', 'esta tela'),
    cmd('pr --version', 'a versão instalada'),
    `\n  ${c.faint('Apelidos: ls e status = list · log = logs · show = info · rm = delete · unlink = unregister')}`,
    section('VARIÁVEIS DE AMBIENTE'),
    cmd('PR_HOME', 'onde guardar estado e logs (padrão ~/.pr)'),
    cmd('PR_HTTP_PORT · PR_HTTPS_PORT', 'portas do proxy (padrão 80 e 443)'),
    cmd('PR_ACME_DIRECTORY', "outro servidor ACME, ex. o staging do Let's Encrypt"),
    '',
  ];

  console.log(out.join('\n'));
}
