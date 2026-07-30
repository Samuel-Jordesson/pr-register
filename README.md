# PR System

Rode qualquer projeto em segundo plano com um comando, veja em que porta ele subiu e publique num domínio seu com HTTPS. Um `pm2` enxuto com um pedaço de `nginx` embutido — em Node puro, sem dependências.

Documentação completa (uso, instalação, arquitetura interna e como mexer no código): [DOCUMENTACAO.md](DOCUMENTACAO.md).

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

Uma linha, no servidor:

```bash
curl -fsSL https://raw.githubusercontent.com/Samuel-Jordesson/pr-register/main/install.sh | sh
```

Precisa de Node 20+ e roda em Linux (a descoberta de portas usa `/proc` e `ss`). Sem dependências.

O instalador baixa o código para `/usr/local/lib/pr-register` e cria o comando em `/usr/local/bin/pr`. Rodar de novo **atualiza** para a versão mais recente. Opções, se precisar:

```bash
# instala o Node por você, via nvm, se estiver faltando
curl -fsSL .../install.sh | PR_NODE=1 sh

# já libera as portas 80 e 443 para o node (evita o passo do setcap depois)
curl -fsSL .../install.sh | PR_SETCAP=1 sh

# instala em outro lugar, sem sudo
curl -fsSL .../install.sh | PR_PREFIX=$HOME/.local sh

# instala uma tag ou branch específica
curl -fsSL .../install.sh | PR_REF=v0.1.0 sh
```

Sem sudo e sem escrita em `/usr/local`, ele cai para `~/.local` sozinho e avisa se essa pasta não estiver no PATH.

### Instalando a partir do clone

```bash
git clone https://github.com/Samuel-Jordesson/pr-register.git
cd pr-register
sudo npm install -g . --prefix /usr/local     # ou: sh install.sh
```
### Pode usar tambem assim
```bash
curl -fsSL https://raw.githubusercontent.com/Samuel-Jordesson/pr-register/main/install.sh | sh
pr proxy stop && pr proxy start

```

### Atenção: já existe um `pr` no sistema

O `pr` do GNU coreutils (`/usr/bin/pr`, um paginador de texto que quase ninguém usa) ocupa o nome. O instalador acima não sofre com isso — ele escreve em `/usr/local/bin`, que vem antes no PATH, e avisa se algum outro `pr` estiver na frente. Já a instalação via `npm install -g` falha se o seu npm usa o prefixo `/usr` — o caso do Node vindo do `apt` no Ubuntu:

```
npm error EEXIST: file already exists
npm error File exists: /usr/bin/pr
```

Instalar com `--prefix /usr/local` resolve: `/usr/local/bin` vem antes de `/usr/bin` no PATH, então o `pr` deste projeto passa a atender e o do coreutils continua intacto em `/usr/bin/pr`. **Nunca use `npm install -g . --force`** aqui: ele sobrescreve um arquivo do coreutils gerenciado pelo `dpkg`.

Confira qual está valendo:

```bash
which pr        # esperado: /usr/local/bin/pr
pr --version    # esperado: pr 0.1.0
```

Se preferir não substituir o comando do sistema, instale com outro nome:

```bash
sudo ln -sf /usr/local/lib/node_modules/pr-register/bin/pr.js /usr/local/bin/prj
```

Para desenvolver no próprio clone, `npm link` funciona igual — com a mesma ressalva do prefixo.

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

## Problemas comuns

### `EEXIST: file already exists /usr/bin/pr`

O nome `pr` já é do paginador do GNU coreutils. Explicado na seção de instalação — resumo: instale com `--prefix /usr/local` e nunca com `--force`.

```bash
sudo npm install -g . --prefix /usr/local
```

### `EACCES` ao subir o proxy

No Linux só o root abre portas abaixo de 1024, e o proxy precisa da 80 (é lá que o Let's Encrypt bate para validar o domínio) e da 443. Escolha um:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which node)   # dá ao node o direito de abrir portas baixas
pr proxy start
```

```bash
sudo pr proxy start                                     # ou roda o proxy como root
```

O `setcap` é a opção mais contida: concede só essa capacidade ao binário do node, em vez de rodar tudo como root. Refaça o comando quando trocar de versão do Node (o caminho do binário muda). Para testar sem privilégio nenhum:

```bash
PR_HTTP_PORT=8080 PR_HTTPS_PORT=8443 pr proxy start
```

### A bolinha do domínio não fica verde

Rode `pr register` para ver o motivo em texto, e `pr proxy logs` para o detalhe. Por ordem de probabilidade:

- **`DNS ainda não resolve` / `DNS aponta para outro IP`** — o registro A não foi salvo, ainda está propagando, ou aponta para outro lugar. Confira com `dig +short seudominio.com.br` e compare com o IP que o `pr proxy status` mostra. Propagação leva de minutos a algumas horas; enquanto isso o `pr` não tenta emitir nada, justamente para não gastar as tentativas do Let's Encrypt.
- **Mais de um registro A no mesmo nome** — o caso mais traiçoeiro: o site abre normalmente, mas o certificado nunca sai. Se o domínio resolve para dois IPs (o do VPS e o que já vinha da Hostinger, por exemplo), o Let's Encrypt sorteia um deles para validar o desafio e metade das tentativas cai no servidor errado. A lista do `pr register` avisa: `apague o registro A extra: 2.57.91.91`. Deixe **um só** registro A, com o IP do VPS.

```bash
dig +short seudominio.com.br @1.1.1.1   # deve responder um único IP
```

- **Se a Hostinger estiver com o proxy/CDN dela ligado**, o DNS vai resolver para o IP *dela*, não o seu, e a validação falha. Desligue o proxy do domínio ou aponte o A direto para o VPS.

- **Cache negativo do resolvedor do VPS** — se você criou o registro A depois de já ter consultado o domínio, o `systemd-resolved` pode insistir no "não existe" por um tempo. O `pr` contorna isso consultando `1.1.1.1` quando o resolvedor local não traz nada, mas dá para limpar na mão:

```bash
sudo resolvectl flush-caches
```
- **Porta 80 fechada** — o desafio HTTP-01 é uma requisição da internet para `http://seudominio/.well-known/acme-challenge/...`. Precisa estar aberta no firewall do sistema **e** no painel do provedor (security group / firewall do VPS), que são coisas separadas:

```bash
sudo ufw allow 80 && sudo ufw allow 443
curl -I http://seudominio.com.br/.well-known/acme-challenge/teste   # de fora do servidor
```

- **`too many failed authorizations`** — o Let's Encrypt limita as tentativas com erro (5 por hora por domínio). Espere ou teste apontando para o staging, que tem limites folgados:

```bash
PR_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory pr proxy start
```

O certificado do staging não é aceito pelos navegadores — serve só para confirmar que o fluxo funciona. Apague `~/.pr/certs/<dominio>` antes de emitir o de produção.

### `502` no navegador, ou `"projeto" não está no ar`

O proxy achou o domínio mas não achou o projeto atrás dele. Veja `pr list`:

- coluna `PORTA` vazia — o projeto não abriu porta nenhuma, ou escuta num endereço que o `pr` não enxerga. Faça o app escutar em `0.0.0.0` ou `127.0.0.1`, não num IP externo específico;
- status `errored` ou `restarting` — o comando está caindo; `pr logs <nome>` mostra o motivo.

### `404 nenhum projeto registrado para este domínio`

O `Host` que chegou não casa com nenhum domínio do `pr register`. Costuma ser acesso pelo IP puro (sem domínio) ou um subdomínio de um domínio que você não registrou. No navegador aparece uma página escura com a logo; no `curl` continua sendo uma linha de texto.

Para trocar essa página pela sua, crie o arquivo — o proxy usa na hora, sem reiniciar:

```bash
mkdir -p ~/.pr/pages
nano ~/.pr/pages/404.html      # e ~/.pr/pages/502.html para "projeto fora do ar"
```

### O projeto some depois de reiniciar o VPS

Ainda não há integração com o systemd: os processos e o proxy não voltam sozinhos. Depois do boot:

```bash
pr proxy start
cd ~/meu-projeto && pr npm run dev
```

### `pr` não é o comando certo

Se `which pr` responder `/usr/bin/pr`, o do coreutils está na frente. Confira a ordem do PATH (`echo $PATH`) — `/usr/local/bin` precisa vir antes de `/usr/bin` — ou chame por um nome só seu, como descrito na instalação.

## Testes

```bash
npm test
```

Cobrem a leitura de portas nos logs, a árvore de processos, o alinhamento da tabela com escapes ANSI, a validação de domínios e o CSR do ACME (conferido com o `openssl`, quando disponível). O cliente ACME foi validado contra o ambiente de staging do Let's Encrypt.

## Estrutura

| Arquivo | Responsabilidade |
| --- | --- |
| `install.sh` | instalador de uma linha |
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
| `src/pages.js` · `assets/` | páginas 404/502 e a logo |
| `src/domains.js` | vínculos domínio → projeto |
| `src/prompt.js` | seleção com setas e entrada de texto |
| `src/ui.js` | cores, tabelas e caixas |

## Licença

MIT
