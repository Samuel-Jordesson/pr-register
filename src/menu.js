// A tela que aparece quando você digita só `pr`.

import fs from 'node:fs';
import path from 'node:path';
import * as domainsCli from './register.js';
import { startAndReport, shortenPath } from './start.js';
import { select, ask, isInteractive } from './prompt.js';
import { c, ok, info, fail } from './ui.js';

const VERSION = '0.1.0';

export function isMenuAvailable() {
  return isInteractive();
}

export async function cmdMenu() {
  console.log();
  console.log(
    `  ${c.bold(c.accent('PR System'))} ${c.faint(`v${VERSION}`)}`
  );

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
        label: c.faint('conectar via Cloudflare'),
        hint: 'em breve',
        value: 'cloudflare',
      },
      { label: c.faint('sair'), hint: '', value: null },
    ],
    { title: 'o que você quer fazer?' }
  );

  if (choice === 'register') return domainsCli.cmdRegister();
  if (choice === 'run') return runProject();
  if (choice === 'cloudflare') return cloudflareSoon();

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

function cloudflareSoon() {
  console.log();
  info('conectar via Cloudflare ainda não está pronto');
  console.log(
    `  ${c.faint('por enquanto, use')} ${c.accent('pr register')} ${c.faint('— registro A + certificado do Let\'s Encrypt')}`
  );
  console.log();
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
