// A tela que aparece quando você digita só `pr`.

import fs from 'node:fs';
import path from 'node:path';
import * as domainsCli from './register.js';
import { cmdCloudflare } from './cftunnel.js';
import { startAndReport, shortenPath } from './start.js';
import { select, ask, isInteractive } from './prompt.js';
import { c, box, width, info, fail } from './ui.js';

const VERSION = '0.1.0';


/** A marca do PR System, em arte de terminal. */
const LOGO = [
  '██████╗ ██████╗ ███████╗██╗   ██╗███████╗████████╗███████╗███╗   ███╗',
  '██╔══██╗██╔══██╗██╔════╝╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝████╗ ████║',
  '██████╔╝██████╔╝███████╗ ╚████╔╝ ███████╗   ██║   █████╗  ██╔████╔██║',
  '██╔═══╝ ██╔══██╗╚════██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██║╚██╔╝██║',
  '██║     ██║  ██║███████║   ██║   ███████║   ██║   ███████╗██║ ╚═╝ ██║',
  '╚═╝     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝',
];

const LOGO_LARGURA = Math.max(...LOGO.map((l) => l.length));

const TAGLINE = [
  'Rode qualquer projeto em segundo plano e publique',
  'cada um no seu próprio domínio, com HTTPS automático.',
];

/**
 * Cabeçalho do menu. A arte é alta: em terminal baixo ela seria cortada
 * e roubaria a tela das opções, então some e fica só o texto.
 */
function header() {
  // a arte só entra se couber inteira: cortada ao meio fica pior que ausente
  const cabe = (process.stdout.columns || 80) >= LOGO_LARGURA + 6 && (process.stdout.rows || 24) >= 18;

  const rodape = `${c.faint('versão')} ${c.dim(VERSION)}  ${c.faint('·')} ${c.faint('zero dependências')}  ${c.faint('·')} ${c.faint('pr help para todos os comandos')}`;
  const largura = Math.max(width(rodape), ...TAGLINE.map(width), cabe ? LOGO_LARGURA : 0);
  const centralizar = (linha) =>
    ' '.repeat(Math.max(0, Math.floor((largura - linha.length) / 2))) + linha;

  const linhas = [
    ...(cabe ? [...LOGO.map((l) => c.accent(centralizar(l))), ''] : []),
    ...TAGLINE.map((l) => c.text(l)),
    '',
    rodape,
  ];

  return box(linhas, { title: 'PR System' });
}

export function isMenuAvailable() {
  return isInteractive();
}

export async function cmdMenu() {
  console.log();
  console.log(header());
  console.log();

  const choice = await select(
    [
      {
        label: 'registrar domínio',
        hint: 'publica um projeto num domínio seu, com https',
        value: 'register',
      },
      {
        label: 'rodar projeto',
        hint: 'sobe um projeto em segundo plano',
        value: 'run',
      },
      {
        label: 'conectar via Cloudflare',
        hint: 'publica por túnel, sem precisar de IP público',
        value: 'cloudflare',
      },
      { label: c.faint('sair'), hint: '', value: null },
    ],
    { title: 'o que você quer fazer?' }
  );

  if (choice === 'register') return domainsCli.cmdRegister();
  if (choice === 'run') return runProject();
  if (choice === 'cloudflare') return cmdCloudflare();

  console.log();
  console.log(`  ${c.faint('até mais. Todos os comandos: pr help')}`);
  console.log();
}

/** Pergunta a pasta e o comando, e sobe o projeto. */
async function runProject() {
  const here = process.cwd();

  const answer = await ask('pasta do projeto:', { defaultValue: here });
  if (answer === null) return canceled();

  const cwd = resolveFolder(answer);
  if (!cwd) {
    fail(`"${answer}" não é uma pasta que eu consiga abrir`);
    console.log();
    return;
  }

  const suggestion = guessCommand(cwd);
  const command = await ask('comando para iniciar:', {
    defaultValue: suggestion,
    placeholder: suggestion || 'ex.: npm run dev',
  });
  if (command === null) return canceled();
  if (!command) {
    fail('preciso de um comando para rodar. Ex.: npm run dev');
    console.log();
    return;
  }

  console.log();
  info(`${c.text(command)} ${c.faint('em')} ${c.faint(shortenPath(cwd, 48))}`);

  const subiu = await startAndReport({ command, cwd });
  if (subiu) {
    console.log(`  ${c.faint('para publicar num domínio: pr register')}`);
    console.log();
  }
}

function canceled() {
  console.log();
  console.log(`  ${c.faint('cancelado')}`);
  console.log();
}

/** Aceita ~, caminho relativo e caminho absoluto; devolve null se não existir. */
function resolveFolder(input) {
  const expanded = input.startsWith('~')
    ? path.join(process.env.HOME || '', input.slice(1))
    : input;
  const full = path.resolve(expanded);
  try {
    return fs.statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/** Palpite de comando, olhando o que existe na pasta. */
function guessCommand(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    for (const name of ['dev', 'start', 'serve']) {
      if (scripts[name]) return `npm run ${name}`;
    }
  } catch {
    // sem package.json, ou ilegível: tenta outros sinais
  }

  const sinais = [
    ['manage.py', 'python3 manage.py runserver'],
    ['artisan', 'php artisan serve'],
    ['go.mod', 'go run .'],
    ['Cargo.toml', 'cargo run'],
    ['index.html', 'python3 -m http.server 3000'],
  ];
  for (const [arquivo, comando] of sinais) {
    if (fs.existsSync(path.join(cwd, arquivo))) return comando;
  }
  return '';
}
