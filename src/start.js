// Sobe um projeto e conta o que aconteceu. Usado pelo `pr <comando>` e
// pelo menu interativo — os dois precisam mostrar exatamente a mesma coisa.

import path from 'node:path';
import * as store from './store.js';
import * as runner from './runner.js';
import { c, box, ok, fail, truncate } from './ui.js';

export function shortenPath(p, max = Infinity) {
  const home = process.env.HOME;
  const short = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  // em caminho longo o fim importa mais que o começo
  return short.length <= max ? short : '…' + short.slice(short.length - max + 1);
}

/**
 * Sobe o comando, espera a porta aparecer e imprime o resultado.
 * @returns {Promise<boolean>} subiu de pé?
 */
export async function startAndReport({ command, cwd, name }) {
  const dir = path.resolve(cwd || process.cwd());

  let proc;
  try {
    proc = runner.start(command, { cwd: dir, name });
  } catch (err) {
    fail(err.message);
    process.exitCode = 1;
    return false;
  }

  console.log();
  console.log(
    box(
      [
        `${c.dim('comando')}  ${c.text(truncate(command, 48))}`,
        `${c.dim('pasta')}    ${c.faint(shortenPath(dir, 48))}`,
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
    console.log();
    return true;
  }

  fail(`"${proc.name}" não ficou de pé (${final.status})`);
  const tail = runner.tailText(proc.name, 2000).trimEnd().split('\n').slice(-8);
  if (tail.length) {
    console.log();
    for (const line of tail) console.log(`  ${c.faint('│')} ${line}`);
  }
  console.log();
  process.exitCode = 1;
  return false;
}
