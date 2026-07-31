// `pr startup` e `pr resurrect` — voltar tudo ao ar depois de reiniciar.
//
// O estado em ~/.pr já diz o que estava rodando quando a máquina caiu:
// os arquivos ficam lá com o pid antigo. Ressuscitar é subir de novo tudo
// que estava de pé, e o systemd cuida de chamar isso no boot.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as store from './store.js';
import * as runner from './runner.js';
import * as proxyctl from './proxyctl.js';
import { statePath } from './proxy.js';
import { c, box, ok, info, warn, fail } from './ui.js';

const UNIT = '/etc/systemd/system/pr.service';

const souRoot = () => process.getuid?.() === 0;

function comandoPr() {
  // o lançador instalado, não o node solto: ele já fixa o caminho do node
  const candidatos = ['/usr/local/bin/pr', path.join(os.homedir(), '.local/bin/pr')];
  for (const caminho of candidatos) {
    if (fs.existsSync(caminho)) return caminho;
  }
  try {
    return execFileSync('sh', ['-c', 'command -v pr'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function unidade({ usuario, home, prBin, prHome = store.HOME }) {
  return `[Unit]
Description=PR System — devolve os projetos ao ar depois do boot
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=${usuario}
Environment=HOME=${home}
Environment=PR_HOME=${prHome}
ExecStart=${prBin} resurrect
ExecStop=${prBin} stop all
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
`;
}

// ── pr startup ───────────────────────────────────────────────────────────

export async function cmdStartup(args = []) {
  const remover = args[0] === 'remove' || args[0] === 'rm' || args.includes('--remove');

  console.log();

  if (!fs.existsSync('/run/systemd/system')) {
    fail('esta máquina não usa systemd — não sei criar o serviço de boot aqui');
    console.log();
    process.exitCode = 1;
    return;
  }

  const prBin = comandoPr();
  if (!prBin) {
    fail('não achei o comando pr instalado');
    console.log(`  ${c.faint('instale com o install.sh e rode de novo')}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  if (!souRoot()) {
    // escrever em /etc/systemd exige root; melhor pedir do que falhar no meio
    warn('preciso de root para instalar o serviço');
    console.log(`  ${c.faint('rode:')} ${c.accent(`sudo ${prBin} startup${remover ? ' remove' : ''}`)}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  if (remover) return desinstalar();

  // com sudo, SUDO_USER é quem realmente vai rodar os projetos
  const usuario = process.env.SUDO_USER || os.userInfo().username;
  const home = usuario === os.userInfo().username ? os.homedir() : `/home/${usuario}`;

  fs.writeFileSync(UNIT, unidade({ usuario, home, prBin }));
  systemctl(['daemon-reload']);
  systemctl(['enable', 'pr.service']);

  ok('serviço de boot instalado');
  console.log();
  console.log(
    box(
      [
        `${c.dim('unidade')}  ${c.text(UNIT)}`,
        `${c.dim('usuário')}  ${c.text(usuario)}`,
        `${c.dim('estado')}   ${c.text(store.HOME)}`,
      ],
      { title: 'pr.service' }
    )
  );
  console.log();
  info('no próximo boot, tudo que estiver no ar agora volta sozinho');
  console.log(`  ${c.faint('testar sem reiniciar: sudo systemctl start pr')}`);
  console.log(`  ${c.faint(`desinstalar: sudo ${prBin} startup remove`)}`);
  console.log();
}

function desinstalar() {
  try {
    systemctl(['disable', 'pr.service']);
  } catch {
    // já estava desabilitado
  }
  fs.rmSync(UNIT, { force: true });
  systemctl(['daemon-reload']);
  ok('serviço de boot removido');
  console.log(`  ${c.faint('os projetos continuam rodando até a máquina reiniciar')}`);
  console.log();
}

function systemctl(args) {
  return execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** O serviço está instalado e habilitado? */
export function estadoStartup() {
  if (!fs.existsSync(UNIT)) return { instalado: false };
  try {
    const habilitado = systemctl(['is-enabled', 'pr.service']).trim();
    return { instalado: true, habilitado: habilitado === 'enabled' };
  } catch {
    return { instalado: true, habilitado: false };
  }
}

// ── pr resurrect ─────────────────────────────────────────────────────────

/**
 * Sobe de novo tudo que estava no ar. Os arquivos de estado guardam o
 * último status conhecido: depois de um reboot eles apontam para pids
 * que já não existem, e é justamente essa a lista a restaurar.
 */
export async function cmdResurrect() {
  console.log();

  const registrados = store.list();
  const mortos = registrados.filter((proc) => {
    const vivo = runner.liveStatus(proc);
    return !vivo.alive && ['online', 'starting', 'restarting'].includes(proc.status);
  });

  const proxyEstavaNoAr = fs.existsSync(statePath()) && !proxyctl.status().running;

  if (!mortos.length && !proxyEstavaNoAr) {
    const jaNoAr = registrados.filter((p) => runner.liveStatus(p).alive).length;
    info(jaNoAr ? `nada a restaurar — ${jaNoAr} já no ar` : 'nada para restaurar');
    console.log();
    return;
  }

  for (const proc of mortos) {
    try {
      runner.start(proc.command, { cwd: proc.cwd, name: proc.name, env: proc.env });
      ok(`${c.text(proc.name)} ${c.faint(`(${proc.command})`)}`);
    } catch (err) {
      fail(`${proc.name}: ${err.message}`);
    }
  }

  if (proxyEstavaNoAr) {
    const resultado = await proxyctl.start();
    if (resultado.running) {
      ok(`proxy ${c.faint(`(portas ${resultado.ports.http} e ${resultado.ports.https})`)}`);
    } else {
      fail(`proxy: ${resultado.error}`);
      if (String(resultado.error).includes('EACCES')) {
        console.log(`  ${c.faint("falta o setcap: sudo setcap 'cap_net_bind_service=+ep' $(which node)")}`);
      }
    }
  }

  // dá tempo das portas aparecerem antes de conferir
  await new Promise((r) => setTimeout(r, 3000));

  const noAr = store.list().filter((p) => runner.liveStatus(p).alive).length;
  console.log();
  info(`${noAr} no ar`);
  console.log(`  ${c.faint('confira com: pr list')}`);
  console.log();
}
