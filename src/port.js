// `pr port` — abre no firewall a porta em que um projeto está rodando.

import * as store from './store.js';
import * as runner from './runner.js';
import * as firewall from './firewall.js';
import { c, box, tableLines, RULE, symbols, ok, info, warn, fail } from './ui.js';

export async function cmdPort(args = []) {
  const alvo = args[0];

  console.log();
  const tipo = firewall.detectar();

  if (!alvo) return listar(tipo);

  const porta = Number(alvo);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    fail(`"${alvo}" não é uma porta. Ex.: pr port 3000`);
    console.log();
    process.exitCode = 1;
    return;
  }

  if (tipo === 'nenhum') {
    warn('nenhum firewall ativo nesta máquina — a porta já está liberada aqui dentro');
    console.log(`  ${c.faint('se ainda não abre de fora, o bloqueio está no painel do provedor')}`);
    console.log();
    return;
  }

  if (firewall.estaAberta(porta, tipo) === true) {
    ok(`a porta ${c.accent(String(porta))} já está aberta no ${c.text(tipo)}`);
    console.log();
    lembreteProvedor(porta);
    return;
  }

  info(`abrindo a porta ${c.accent(String(porta))} no ${c.text(tipo)}…`);
  const resultado = firewall.abrir(porta, tipo);

  console.log();
  if (!resultado.ok) {
    fail(resultado.erro);
    if (resultado.comando) {
      console.log(`  ${c.faint('rode na mão:')} ${c.text(resultado.comando)}`);
    }
    console.log();
    process.exitCode = 1;
    return;
  }

  ok(`porta ${c.accent(String(porta))} aberta`);
  if (!firewall.persiste(tipo)) {
    console.log();
    warn('o iptables puro perde essa regra no próximo boot');
    console.log(`  ${c.faint('para fixar: sudo apt install iptables-persistent')}`);
  }
  console.log();
  lembreteProvedor(porta);
}

/** O firewall do provedor é outra camada, e de fora do alcance do pr. */
function lembreteProvedor(porta) {
  console.log(
    box(
      [
        `${c.dim('Isto abriu só o firewall desta máquina.')}`,
        `${c.dim('Num VPS, libere a porta também no painel do provedor:')}`,
        '',
        `  ${c.text('Oracle Cloud')}  ${c.faint('Networking → VCN → Security Lists → Ingress Rules')}`,
        `  ${c.text('AWS')}           ${c.faint('EC2 → Security Groups → Inbound rules')}`,
        `  ${c.text('Hostinger')}     ${c.faint('VPS → Firewall')}`,
        '',
        `${c.dim('Conferir de fora:')} ${c.text(`curl http://SEU_IP:${porta}`)}`,
      ],
      { title: 'falta o firewall do provedor' }
    )
  );
  console.log();
}

/** Sem argumento: mostra as portas dos projetos e se estão liberadas. */
function listar(tipo) {
  const projetos = store
    .list()
    .map(runner.inspect)
    .filter((p) => p.status === 'online' && p.ports.length);

  if (!projetos.length) {
    info('nenhum projeto no ar com porta detectada');
    console.log(`  ${c.faint('suba um com: pr npm run dev')}`);
    console.log();
    return;
  }

  const linhas = projetos.flatMap((p) =>
    p.ports.map((porta) => {
      const aberta = firewall.estaAberta(porta, tipo);
      const bolinha =
        aberta === true ? c.green(symbols.bullet) : aberta === false ? c.red(symbols.bullet) : c.faint(symbols.bullet);
      const situacao =
        aberta === true
          ? c.green('aberta')
          : aberta === false
            ? c.yellow(`fechada — pr port ${porta}`)
            : c.faint('não sei dizer');

      return {
        porta: `${bolinha} ${c.accent(String(porta))}`,
        projeto: c.text(p.name),
        situacao,
      };
    })
  );

  const [cabecalho, ...corpo] = tableLines(
    [
      { key: 'porta', label: 'porta', align: 'right' },
      { key: 'projeto', label: 'projeto' },
      { key: 'situacao', label: 'no firewall' },
    ],
    linhas,
    { indent: '' }
  );

  const rodape =
    tipo === 'nenhum'
      ? c.faint('nenhum firewall ativo nesta máquina')
      : c.faint(`firewall: ${tipo}  ·  abrir: pr port <porta>`);

  console.log(box([cabecalho, RULE, ...corpo, RULE, rodape], { title: 'portas' }));
  console.log();
}
