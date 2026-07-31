// `pr register` e amigos: liga um domínio a um projeto que está rodando.

import * as store from './store.js';
import * as runner from './runner.js';
import * as domains from './domains.js';
import * as proxyctl from './proxyctl.js';
import { publicIp, pointsHere } from './net.js';
import { select, ask, isInteractive } from './prompt.js';
import { c, box, tableLines, RULE, symbols, ok, info, fail, truncate } from './ui.js';

/**
 * Estado de um vínculo, do ponto de vista de quem está esperando funcionar.
 * @returns {Promise<{binding:object, dot:string, label:string, port:number|null}>}
 */
async function inspectBinding(binding, serverIp) {
  const proc = store.read(binding.process);
  const live = proc ? runner.inspect(proc) : null;
  const port = live?.ports[0] ?? null;
  const cert = domains.certInfo(binding.domain);
  const { pointing, records, extras } = await pointsHere(binding.domain, serverIp);

  let dot = c.red(symbols.bullet);
  let label = 'esperando o DNS';

  if (!live || live.status !== 'online') {
    dot = c.red(symbols.bullet);
    label = `${binding.process} não está no ar`;
  } else if (!pointing) {
    label = records.length ? `DNS aponta para ${records[0]}` : 'DNS ainda não resolve';
  } else if (extras.length) {
    // dois A no mesmo nome: o Let's Encrypt sorteia qual IP validar
    dot = c.yellow(symbols.bullet);
    label = `apague o registro A extra: ${extras.join(', ')}`;
  } else if (!cert.ok) {
    dot = c.yellow(symbols.bullet);
    label = binding.lastError ? truncate(binding.lastError, 34) : 'emitindo certificado';
  } else {
    dot = c.green(symbols.bullet);
    label = 'conectado';
  }

  return { binding, dot, label, port, pointing, extras, cert };
}

async function showBindings() {
  const list = domains.all();
  if (!list.length) return false;

  const { ip } = await publicIp();
  const rows = await Promise.all(list.map((b) => inspectBinding(b, ip)));

  const [header, ...body] = tableLines(
    [
      { key: 'domain', label: 'domínio' },
      { key: 'project', label: 'projeto' },
      { key: 'port', label: 'porta', align: 'right' },
      { key: 'state', label: 'situação' },
    ],
    rows.map((r) => ({
      domain: `${r.dot} ${c.text(r.binding.domain)}`,
      project: c.dim(r.binding.process),
      port: r.port ? c.accent(String(r.port)) : c.faint('—'),
      state:
        r.cert.ok && r.pointing && !r.extras.length
          ? c.green(r.label)
          : r.extras.length
            ? c.yellow(r.label)
            : c.faint(r.label),
    })),
    { indent: '' }
  );

  const proxy = proxyctl.status();
  const footer = proxy.running
    ? c.faint(`proxy no ar (pid ${proxy.pid})`)
    : c.yellow('proxy parado — pr proxy start');

  console.log(box([header, RULE, ...body, RULE, footer], { title: 'domínios' }));
  console.log();
  return true;
}

/** Instruções de DNS para colar no registrador. */
export function dnsInstructions(domain, ip, { source } = {}) {
  const [headerLine, ...rowLines] = tableLines(
    [
      { key: 'type', label: 'tipo' },
      { key: 'name', label: 'nome' },
      { key: 'value', label: 'valor' },
      { key: 'ttl', label: 'ttl', align: 'right' },
    ],
    [
      { type: c.text('A'), name: c.text('@'), value: c.accent(ip || '?'), ttl: c.dim('3600') },
      { type: c.text('A'), name: c.text('www'), value: c.accent(ip || '?'), ttl: c.dim('3600') },
    ],
    { indent: '' }
  );

  const lines = [
    `${c.dim('Na Hostinger:')} ${c.text('Domínios → seu domínio → Zona DNS')}`,
    `${c.dim('No Registro.br:')} ${c.text('Meus domínios → DNS → Editar zona')}`,
    '',
    headerLine,
    ...rowLines,
  ];

  if (source === 'local') {
    lines.push(
      '',
      c.yellow(`! ${ip} é um IP de rede local — só funciona se este servidor`),
      c.yellow('  estiver acessível da internet nesse endereço')
    );
  }

  return box(lines, { title: `aponte ${domain} para cá` });
}

export async function cmdRegister() {
  console.log();
  const had = await showBindings();

  const running = store
    .list()
    .map(runner.inspect)
    .filter((p) => p.status === 'online');

  if (!isInteractive()) {
    if (!had) info('nada registrado ainda. Rode `pr register` num terminal para escolher um projeto.');
    return;
  }

  if (!running.length) {
    info('nenhum projeto no ar para registrar. Suba um com `pr npm run dev`.');
    console.log();
    return;
  }

  const items = running.map((p) => ({
    label: `${p.name}`,
    hint: `porta ${p.ports[0] ?? '—'}${domains.forProcess(p.name).length ? `  ${domains.forProcess(p.name).map((b) => b.domain).join(', ')}` : ''}`,
    value: p,
  }));
  items.push({ label: c.faint('sair'), hint: '', value: null });

  const chosen = await select(items, { title: 'qual projeto quer publicar num domínio?' });
  if (!chosen) {
    console.log();
    return;
  }

  const answer = await ask('domínio (ex.: meuapp.com.br):', { placeholder: 'enter para cancelar' });
  if (!answer) {
    console.log();
    return;
  }
  if (!domains.isValid(answer)) {
    fail(`"${answer}" não parece um domínio válido`);
    console.log();
    return;
  }

  const domain = domains.normalize(answer);
  const existing = domains.get(domain);
  if (existing && existing.process !== chosen.name) {
    info(`${domain} estava ligado a ${existing.process}, passando para ${chosen.name}`);
  }

  domains.add({ domain, process: chosen.name });
  console.log();
  ok(`${c.text(domain)} ${c.faint('→')} ${c.text(chosen.name)} ${c.faint(`(porta ${chosen.ports[0] ?? '?'})`)}`);
  console.log();

  const { ip, source } = await publicIp();
  console.log(dnsInstructions(domain, ip, { source }));
  console.log();

  const proxy = await proxyctl.start();
  if (proxy.running) {
    ok(`proxy no ar nas portas ${proxy.ports.http} e ${proxy.ports.https}`);
  } else if (String(proxy.error).includes('EACCES')) {
    fail('o proxy não conseguiu abrir a porta 80');
    console.log();
    console.log(
      proxyctl
        .permissionHint()
        .split('\n')
        .map((l) => `  ${c.faint(l)}`)
        .join('\n')
    );
  } else {
    fail(`proxy não subiu: ${proxy.error}`);
  }

  console.log();
  info(
    `assim que o DNS propagar (${c.dim('minutos a algumas horas')}), o certificado sai sozinho.`
  );
  console.log(`  ${c.faint(`confira com: pr register   ·   detalhes: pr proxy logs`)}`);
  console.log();
}

export async function cmdUnregister(args) {
  if (!args.length) {
    fail('informe o domínio. Ex.: pr unregister meuapp.com.br');
    process.exitCode = 1;
    return;
  }

  console.log();
  for (const arg of args) {
    const binding = domains.get(arg);
    if (!binding) {
      fail(`"${arg}" não está registrado`);
      process.exitCode = 1;
      continue;
    }
    domains.remove(binding.domain);
    ok(`${c.text(binding.domain)} ${c.faint('removido (o certificado também)')}`);
  }
  console.log();
}

export async function cmdProxy(args) {
  const action = args[0] || 'status';

  if (action === 'start') {
    console.log();
    const result = await proxyctl.start();
    if (result.running) {
      ok(`proxy no ar ${c.faint(`(pid ${result.pid}, portas ${result.ports.http} e ${result.ports.https})`)}`);
    } else {
      fail(`não subiu: ${result.error}`);
      if (String(result.error).includes('EACCES')) {
        console.log();
        console.log(proxyctl.permissionHint().split('\n').map((l) => `  ${c.faint(l)}`).join('\n'));
      }
      process.exitCode = 1;
    }
    console.log();
    return;
  }

  if (action === 'stop') {
    console.log();
    const stopped = await proxyctl.stop();
    if (stopped) ok('proxy parado');
    else info('o proxy já estava parado');
    console.log();
    return;
  }

  if (action === 'logs') {
    const { default: fs } = await import('node:fs');
    const text = runner.tailText('_proxy', 32 * 1024);
    const lines = text.trimEnd().split('\n');
    const count = Number(args[1]) || 30;
    console.log();
    for (const line of lines.slice(-count)) console.log(`  ${c.faint(line)}`);
    console.log();
    if (args.includes('-f')) {
      const file = store.logFile('_proxy');
      let position = fs.existsSync(file) ? fs.statSync(file).size : 0;
      fs.watchFile(file, { interval: 250 }, (curr) => {
        if (curr.size <= position) return;
        const stream = fs.createReadStream(file, { start: position, end: curr.size - 1 });
        position = curr.size;
        stream.on('data', (chunk) => process.stdout.write(c.faint(chunk.toString())));
      });
      return new Promise(() => {});
    }
    return;
  }

  // status
  const s = proxyctl.status();
  const { ip, source } = await publicIp();
  const lines = [
    `${c.dim('situação')}  ${s.running ? c.green('no ar') : c.red('parado')}`,
    `${c.dim('pid')}       ${s.pid ? c.text(String(s.pid)) : c.faint('—')}`,
    `${c.dim('portas')}    ${c.text(`${s.ports?.http ?? 80} · ${s.ports?.https ?? 443}`)}`,
    `${c.dim('ip')}        ${c.text(ip || '?')}${source === 'local' ? c.faint(' (rede local)') : ''}`,
    `${c.dim('domínios')}  ${c.text(String(domains.all().length))}`,
  ];
  if (s.error) lines.push(`${c.dim('erro')}      ${c.red(s.error)}`);

  console.log();
  console.log(box(lines, { title: 'proxy' }));
  console.log();
}
