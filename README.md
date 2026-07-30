# pr

Rode qualquer projeto em segundo plano com um comando, veja em que porta ele subiu e publique num domínio seu com HTTPS. Um `pm2` enxuto com um pedaço de `nginx` embutido — em Node puro, sem dependências.

```
$ cd meu-projeto
$ pr npm run dev

╭─ meu-projeto iniciado ────────────────────────╮
│ comando  npm run dev                          │
│ pasta    ~/code/meu-projeto                   │
╰───────────────────────────────────────────────╯

  ✔ rodando em http://localhost:5173
  logs: pr logs meu-projeto -f   ·   parar: pr stop meu-projeto

$ pr list

╭─ processos ──────────────────────────────────────────────────────────╮
│ ID  NOME          STATUS  PORTA  NO AR    MEM  RESTARTS  COMANDO      │
├──────────────────────────────────────────────────────────────────────┤
│  0  ● meu-projeto online   5173    12m  126MB         0  npm run dev  │
│  1  ● api         online   3000     4h   88MB         2  npm start    │
├──────────────────────────────────────────────────────────────────────┤
│ 2 no ar · 0 fora do ar                                               │
╰──────────────────────────────────────────────────────────────────────╯
```

Funciona com qualquer comando, não só npm:

```bash
pr npm run dev
pr npm run web
pr python3 -m http.server 3000
pr go run ./cmd/api
pr start "npm run build && npm start"    # entre aspas quando tiver && | >
```

## Instalação

```bash
git clone https://github.com/Samuel-Jordesson/pr-register.git
cd pr-register
npm install -g .     # ou `npm link` para desenvolver
```

Precisa de Node 20+ e roda em Linux (a descoberta de portas usa `/proc` e `ss`). Sem dependências.

## Comandos

| Comando | O que faz |
| --- | --- |
| `pr <comando>` | roda o comando em segundo plano, nomeado pela pasta atual |
| `pr start <cmd> -n api` | idem, com nome escolhido (`--cwd` muda a pasta) |
| `pr list` | tudo que está rodando, com porta, uptime, memória e restarts |
| `pr logs <alvo> [-f] [-n 50]` | últimas linhas do log, `-f` para acompanhar |
| `pr info <alvo>` | detalhes de um processo |
| `pr restart <alvo\|all>` | reinicia |
| `pr stop <alvo\|all>` | para, mantendo no histórico |
| `pr kill <alvo\|all>` | apelido de `stop` |
| `pr delete <alvo\|all>` | para e remove, junto com os logs |
| `pr clean` | remove tudo que já parou |
| `pr register` | liga um domínio a um projeto (interativo) e lista os já ligados |
| `pr domains` | o mesmo que `pr register`, só a lista |
| `pr unregister <dominio>` | desliga o domínio e apaga o certificado |
| `pr proxy start\|stop\|status` | o proxy que atende as portas 80 e 443 |
| `pr proxy logs [-f]` | o que o proxy e o Let's Encrypt andam fazendo |

O alvo pode ser o nome, o id numérico ou um prefixo único: `pr stop 0`, `pr logs meu`.

## Domínio próprio

```
$ pr register

  qual projeto quer publicar num domínio?

  → Open-Chat  porta 3001
    api        porta 4000
    sair

  ↑ ↓ para navegar · enter para escolher · esc para sair

  ? domínio (ex.: meuapp.com.br): meuapp.com.br

  ✔ meuapp.com.br → Open-Chat (porta 3001)

╭─ aponte meuapp.com.br para cá ────────────────────╮
│ Na Hostinger: Domínios → seu domínio → Zona DNS    │
│ No Registro.br: Meus domínios → DNS → Editar zona  │
│                                                    │
│ TIPO  NOME  VALOR            TTL                   │
│ A     @     203.0.113.45     3600                  │
│ A     www   203.0.113.45     3600                  │
╰────────────────────────────────────────────────────╯

  ✔ proxy no ar nas portas 80 e 443
  → assim que o DNS propagar, o certificado sai sozinho.
```

Cole esses dois registros A na zona DNS do seu registrador e pronto: nada de mexer em nameservers. Rode `pr register` de novo quando quiser conferir — a bolinha conta a história:

| | significado |
| --- | --- |
| 🔴 vermelho | o DNS ainda não aponta para cá (ou o projeto caiu) |
| 🟡 amarelo | DNS certo, certificado sendo emitido |
| 🟢 verde | tudo pronto, servindo em `https://` |

```
╭─ domínios ─────────────────────────────────────────────╮
│ DOMÍNIO          PROJETO    PORTA  SITUAÇÃO             │
├────────────────────────────────────────────────────────┤
│ ● meuapp.com.br  Open-Chat   3001  conectado            │
│ ● api.outro.com  api         4000  esperando o DNS      │
├────────────────────────────────────────────────────────┤
│ proxy no ar (pid 8123)                                  │
╰────────────────────────────────────────────────────────╯
```

O proxy fica de olho: assim que o DNS passa a apontar para o servidor, ele emite o certificado do Let's Encrypt sozinho (desafio HTTP-01 na porta 80), serve em `https`, redireciona o `http` e renova quando faltarem 30 dias. Subdomínios de um domínio registrado caem no mesmo projeto, e WebSocket passa.

### Porta 80 pede permissão

Portas abaixo de 1024 exigem privilégio no Linux. Escolha um:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which node)   # libera o node, uma vez só
sudo pr proxy start                                     # ou roda o proxy como root
```

Para testar sem tocar nas portas privilegiadas: `PR_HTTP_PORT=8080 PR_HTTPS_PORT=8443 pr proxy start`.

### O que o servidor precisa ter

- IP público alcançável da internet (`pr proxy status` mostra qual o `pr` encontrou);
- portas 80 e 443 abertas no firewall e, se houver, no painel do provedor;
- o projeto escutando em `127.0.0.1` ou `0.0.0.0` na porta que aparece no `pr list`.

Use `PR_ACME_DIRECTORY` para apontar ao staging do Let's Encrypt enquanto testa — os limites de emissão do ambiente de produção são baixos.

## Como funciona

Cada processo ganha um supervisor destacado (`src/supervisor.js`) que:

- roda o comando em um grupo de processos próprio, então `pr stop` derruba a árvore inteira (o `npm` e o `node` que ele criou);
- reinicia em caso de queda, com backoff exponencial e limite de 10 tentativas — saída com código 0 é tratada como fim normal, não como crash;
- escreve `stdout` e `stderr` em `~/.pr/logs/<nome>.log` (e os erros também em `<nome>-error.log`), com `FORCE_COLOR=1` para o log manter as cores do dev server.

O estado fica em `~/.pr/procs/<nome>.json`, um arquivo por processo — nenhum daemon central para travar. `pr list` confere os pids de verdade antes de acreditar no arquivo.

A porta vem da árvore de processos: as portas TCP em `LISTEN` são lidas de `ss` (ou `lsof`) e filtradas pelos pids descendentes. Quando nada aparece — um worker sem socket, por exemplo — o log é lido em busca de um `http://localhost:PORT` ou `listening on port PORT`.

Os domínios ficam em `~/.pr/domains.json` e os certificados em `~/.pr/certs/<domínio>/`. O proxy é um processo só, com estado em `~/.pr/proxy.json` e log em `~/.pr/logs/_proxy.log`. O cliente ACME é próprio (JWS ES256, CSR em ASN.1 na mão) — daí o zero dependências.

Defina `PR_HOME` para usar outro diretório de estado (útil em testes).

## Testes

```bash
npm test
```

Cobrem a leitura de portas nos logs, a árvore de processos, o alinhamento da tabela com escapes ANSI, a validação de domínios e o CSR do ACME (conferido com o `openssl`, quando disponível). O cliente ACME foi validado contra o ambiente de staging do Let's Encrypt.

## Estrutura

| Arquivo | Responsabilidade |
| --- | --- |
| `bin/pr.js` | entrada do CLI |
| `src/cli.js` | comandos e ajuda |
| `src/runner.js` | iniciar, parar, reiniciar, inspecionar |
| `src/supervisor.js` | supervisor destacado de cada processo |
| `src/proc.js` | `/proc`, árvore de processos, portas em LISTEN |
| `src/store.js` | estado em `~/.pr` |
| `src/proxy.js` | proxy reverso, TLS e renovação |
| `src/proxyd.js` · `src/proxyctl.js` | daemon do proxy e seu controle |
| `src/acme.js` · `src/asn1.js` | cliente Let's Encrypt e o CSR |
| `src/register.js` | fluxo do `pr register` |
| `src/domains.js` | vínculos domínio → projeto |
| `src/prompt.js` | seleção com setas e entrada de texto |
| `src/ui.js` | cores, tabelas e caixas |

## Licença

MIT
