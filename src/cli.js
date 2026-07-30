// Interface de linha de comando do `pr`.

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as runner from './runner.js';
import * as domainsCli from './register.js';
import { c, tableLines, box, RULE, statusDot, ok, info, fail, since, bytes, truncate } from './ui.js';

const VERSION = '0.1.0';

const KNOWN = new Set([
  'start', 'list', 'ls', 'status', 'stop', 'kill', 'restart', 'logs', 'log',
  'info', 'show', 'delete', 'rm', 'del', 'help', 'clean',
  'register', 'domains', 'unregister', 'unlink', 'proxy',
]);

export async function main(argv) {
  const [first, ...rest] = argv;

  if (!first || first === 'help' || first === '--help' || first === '-h') return help();
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
  const cwd = path.resolve(flags.cwd || process.cwd());

  let proc;
  try {
    proc = runner.start(command, { cwd, name: flags.name });
  } catch (err) {
    fail(err.message);
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(
    box(
      [
        `${c.dim('comando')}  ${c.text(truncate(command, 48))}`,
        `${c.dim('pasta')}    ${c.faint(shortenPath(cwd, 48))}`,
      ],
      { title: `${proc.name} iniciado` }
    )
  );
  console.log();

  const port = await runner.waitForPort(proc.name);
  const final = runner.inspect(store.read(proc.name));

  if (final.status === 'online' || final.status === 'starting') {
    if (port) {
      ok(`rodando em ${c.accent(c.underline(`http://localhost:${port}`))}`);
    } else {
      ok(`rodando em segundo plano ${c.faint(`(pid ${final.pid})`)}`);
    }
    console.log(
      `  ${c.faint(`logs: pr logs ${proc.name} -f   ·   parar: pr stop ${proc.name}`)}`
    );
  } else {
    fail(`"${proc.name}" não ficou de pé (${final.status})`);
    const tail = runner.tailText(proc.name, 2000).trimEnd().split('\n').slice(-8);
    if (tail.length) {
      console.log();
      for (const line of tail) console.log(`  ${c.faint('│')} ${line}`);
    }
    process.exitCode = 1;
  }
  console.log();
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

function shortenPath(p, max = Infinity) {
  const home = process.env.HOME;
  const short = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  // em caminho longo o fim importa mais que o começo
  return short.length <= max ? short : '…' + short.slice(short.length - max + 1);
}

function quote(arg) {
  return /[\s"'$`\\|&;<>()*?[\]{}!#~]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

function help() {
  const cmd = (name, desc) => `${c.accent(name.padEnd(24))} ${c.dim(desc)}`;
  console.log();
  console.log(`  ${c.bold(c.accent('pr'))} ${c.faint(`v${VERSION}`)} ${c.dim('— rode seus projetos em segundo plano')}`);
  console.log();
  console.log(`  ${c.faint('USO')}`);
  console.log(`    ${c.text('pr <comando>')}              ${c.dim('roda o comando em segundo plano')}`);
  console.log();
  console.log(`  ${c.faint('COMANDOS')}`);
  for (const line of [
    cmd('pr npm run dev', 'sobe o projeto da pasta atual'),
    cmd('pr start <cmd> -n api', 'sobe com um nome escolhido'),
    cmd('pr list', 'lista o que está rodando e as portas'),
    cmd('pr logs <nome> -f', 'acompanha os logs'),
    cmd('pr info <nome>', 'detalhes de um processo'),
    cmd('pr restart <nome|all>', 'reinicia'),
    cmd('pr stop <nome|id|all>', 'para, mantendo no histórico'),
    cmd('pr kill <nome|id>', 'o mesmo que stop'),
    cmd('pr delete <nome|all>', 'para e remove, com os logs'),
    cmd('pr clean', 'remove tudo que já parou'),
  ]) {
    console.log(`    ${line}`);
  }
  console.log();
  console.log(`  ${c.faint('DOMÍNIOS')}`);
  for (const line of [
    cmd('pr register', 'liga um domínio a um projeto e mostra o DNS'),
    cmd('pr domains', 'só a lista dos domínios, com o status de cada um'),
    cmd('pr unregister <dominio>', 'desliga o domínio e apaga o certificado'),
    cmd('pr proxy status|start|stop', 'o proxy que atende as portas 80 e 443'),
    cmd('pr proxy logs [-f]', 'o que o proxy e o Let\'s Encrypt estão fazendo'),
  ]) {
    console.log(`    ${line}`);
  }
  console.log();
  console.log(`  ${c.faint('Nome, id ou prefixo funcionam como alvo: pr stop 0, pr logs ap')}`);
  console.log();
}
