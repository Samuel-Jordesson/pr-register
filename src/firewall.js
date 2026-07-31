// Abertura de portas no firewall da máquina. Cobre ufw, firewalld e
// iptables — o que estiver instalado.

import { execFileSync } from 'node:child_process';

const roda = (cmd, args, { silencioso = true } = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: silencioso ? ['ignore', 'pipe', 'ignore'] : 'inherit',
  });

const existe = (cmd) => {
  try {
    roda('sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
};

const souRoot = () => process.getuid?.() === 0;

/** Prefixo de privilégio: nada se já for root, `sudo` se houver. */
function elevar(args) {
  if (souRoot()) return args;
  if (existe('sudo')) return ['sudo', ...args];
  return null;
}

/**
 * Qual firewall está no comando desta máquina.
 * @returns {'ufw'|'firewalld'|'iptables'|'nenhum'}
 */
export function detectar() {
  if (existe('ufw')) {
    try {
      // "Status: active" — se estiver inativo, o ufw não bloqueia nada
      if (/Status:\s*active/i.test(roda('ufw', ['status']))) return 'ufw';
    } catch {
      // sem permissão para consultar: ainda assim é o ufw que manda
      return 'ufw';
    }
  }

  if (existe('firewall-cmd')) {
    try {
      if (/running/i.test(roda('firewall-cmd', ['--state']))) return 'firewalld';
    } catch {
      // não está rodando
    }
  }

  if (existe('iptables')) return 'iptables';
  return 'nenhum';
}

/** A porta já está liberada? `null` quando não dá para saber. */
export function estaAberta(port, tipo = detectar()) {
  try {
    if (tipo === 'ufw') {
      const saida = roda('ufw', ['status']);
      return new RegExp(`^${port}(/tcp)?\\s+ALLOW`, 'mi').test(saida);
    }
    if (tipo === 'firewalld') {
      return roda('firewall-cmd', ['--list-ports']).includes(`${port}/tcp`);
    }
    if (tipo === 'iptables') {
      const saida = roda('iptables', ['-S', 'INPUT']);
      return new RegExp(`--dport ${port}\\b.*-j ACCEPT`).test(saida);
    }
    if (tipo === 'nenhum') return true; // sem firewall, está aberta
  } catch {
    return null; // normalmente falta de permissão para consultar
  }
  return null;
}

/**
 * Libera a porta. Roda com sudo quando necessário — a senha é pedida
 * pelo próprio sudo, no terminal.
 * @returns {{ok:true, comando:string}|{ok:false, erro:string, comando:string}}
 */
export function abrir(port, tipo = detectar()) {
  const receitas = {
    ufw: [['ufw', 'allow', `${port}/tcp`]],
    firewalld: [
      ['firewall-cmd', '--permanent', `--add-port=${port}/tcp`],
      ['firewall-cmd', '--reload'],
    ],
    iptables: [['iptables', '-I', 'INPUT', '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT']],
  };

  const passos = receitas[tipo];
  if (!passos) return { ok: false, erro: 'nenhum firewall reconhecido nesta máquina', comando: '' };

  const comando = passos.map((p) => (souRoot() ? p : ['sudo', ...p]).join(' ')).join(' && ');

  for (const passo of passos) {
    const args = elevar(passo);
    if (!args) return { ok: false, erro: 'preciso de root (ou sudo) para mexer no firewall', comando };

    try {
      roda(args[0], args.slice(1), { silencioso: false });
    } catch (err) {
      return { ok: false, erro: err.message.split('\n')[0], comando };
    }
  }

  return { ok: true, comando };
}

/** O iptables puro esquece as regras no reboot. */
export function persiste(tipo) {
  return tipo !== 'iptables';
}
