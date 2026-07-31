# Documentação do PR System

Tudo sobre o projeto num lugar só: o que é, como instalar, como usar no dia a dia, como funciona por dentro e como mexer no código. O [README.md](README.md) é a versão curta voltada a quem só quer instalar e usar; este arquivo é a referência completa.

## Sumário

- [O que é](#o-que-é)
- [Instalação](#instalação)
- [Uso do dia a dia](#uso-do-dia-a-dia)
  - [O menu interativo](#o-menu-interativo)
- [Domínio próprio e HTTPS](#domínio-próprio-e-https)
- [Cloudflare Tunnel](#cloudflare-tunnel)
- [Subdomínios](#subdomínios)
- [Referência de comandos](#referência-de-comandos)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Onde tudo fica guardado](#onde-tudo-fica-guardado-e-o-formato)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Mapa do código](#mapa-do-código-arquivo-por-arquivo)
- [Como mexer no código](#como-mexer-no-código)
- [Problemas comuns](#problemas-comuns)
- [Segurança](#segurança)
- [Limitações conhecidas](#limitações-conhecidas)

## O que é

O **PR System** (comando `pr`) é um gerenciador de processos para servidor Linux — a mistura de duas ferramentas que normalmente vêm separadas:

- a parte do **pm2**: roda qualquer comando em segundo plano, reinicia sozinho se cair, guarda logs, e continua rodando depois que você fecha o terminal ou desconecta o SSH.
- a parte do **nginx** + **certbot**: um proxy reverso que recebe as requisições em `80`/`443`, decide para qual projeto mandar com base no domínio (`Host`) e emite/renova o certificado HTTPS sozinho, via Let's Encrypt.

Tudo em Node puro, **sem nenhuma dependência de terceiros** — nem no `package.json`, nem instalada por baixo dos panos. O cliente ACME (protocolo do Let's Encrypt), a codificação do CSR (ASN.1/DER) e a interface de terminal são implementados no próprio projeto.

Por que isso importa na prática:

- instalar é baixar um script e rodar — não puxa metade do npm junto;
- não há superfície de ataque de pacote de terceiro comprometido;
- o código inteiro (~3100 linhas) cabe numa leitura de uma tarde, então dá para auditar e entender de ponta a ponta.

## Instalação

### Um comando (recomendado)

```bash
curl -fsSL https://raw.githubusercontent.com/Samuel-Jordesson/pr-register/main/install.sh | sh
```

Requisitos: Linux e Node 20+. Roda de novo para atualizar — o instalador é idempotente.

Variáveis que mudam o comportamento do instalador:

| Variável | Efeito |
| --- | --- |
| `PR_NODE=1` | instala o Node via `nvm` se estiver faltando |
| `PR_SETCAP=1` | já libera as portas 80/443 para o `node` (evita o passo do `setcap` depois) |
| `PR_PREFIX=/caminho` | instala em outro prefixo (padrão: `/usr/local` com sudo, `~/.local` sem) |
| `PR_REF=v0.1.0` | instala uma tag, branch ou commit específico em vez de `main` |

Exemplo comum num VPS novo, deixando tudo pronto de uma vez:

```bash
curl -fsSL https://raw.githubusercontent.com/Samuel-Jordesson/pr-register/main/install.sh | PR_SETCAP=1 sh
```

### A partir do clone

```bash
git clone https://github.com/Samuel-Jordesson/pr-register.git
cd pr-register
sudo npm install -g . --prefix /usr/local     # ou: sh install.sh
```

### Por que não é só `npm install -g .`

O Ubuntu (e a maioria das distros) já tem um comando `pr` — o paginador de texto do GNU coreutils, em `/usr/bin/pr`. Se o npm estiver configurado com prefixo `/usr` (comum quando o Node vem do `apt`), a instalação falha:

```
npm error EEXIST: file already exists
npm error File exists: /usr/bin/pr
```

**Nunca use `--force`** nesse caso — sobrescreveria um binário do `dpkg`. O `install.sh` evita o problema de raiz: instala em `/usr/local/bin`, que vem antes de `/usr/bin` no `PATH`, então o `pr` do projeto atende primeiro e o do coreutils continua intacto.

### O que a instalação cria

```
/usr/local/lib/pr-register/     código-fonte (bin/, src/, assets/)
/usr/local/bin/pr               lançador: exec /caminho/do/node .../bin/pr.js "$@"
```

O lançador **fixa o caminho do Node usado na instalação**. Isso é proposital: faz o `pr` funcionar igual com `sudo`, com `nvm`, ou em qualquer configuração de `PATH`, sem depender do prefixo global do npm. Se você trocar de versão do Node depois, rode o instalador de novo para regravar o lançador.

## Uso do dia a dia

### O menu interativo

Digitando só `pr`, sem argumentos, abre uma tela de escolha:

```
╭─ PR System ──────────────────────────────────────────────────────────╮
│ ██████╗ ██████╗ ███████╗██╗   ██╗███████╗████████╗███████╗███╗   ███╗ │
│ ██╔══██╗██╔══██╗██╔════╝╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝████╗ ████║ │
│ ██████╔╝██████╔╝███████╗ ╚████╔╝ ███████╗   ██║   █████╗  ██╔████╔██║ │
│ ██╔═══╝ ██╔══██╗╚════██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██║╚██╔╝██║ │
│ ██║     ██║  ██║███████║   ██║   ███████║   ██║   ███████╗██║ ╚═╝ ██║ │
│ ╚═╝     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝ │
│                                                                       │
│ Rode qualquer projeto em segundo plano e publique                     │
│ cada um no seu próprio domínio, com HTTPS automático.                 │
│                                                                       │
│ versão 0.1.0  · zero dependências  · pr help para todos os comandos   │
╰───────────────────────────────────────────────────────────────────────╯

  o que você quer fazer?

  → registrar domínio         publica um projeto num domínio seu, com https
    rodar projeto             sobe um projeto em segundo plano
    criar subdomínio          aponta app.seudominio.com para outro projeto
    conectar via Cloudflare   publica por túnel, sem precisar de IP público
    sair

  ↑ ↓ para navegar · enter para escolher · esc para sair
```

- **registrar domínio** — o mesmo fluxo do `pr register`.
- **rodar projeto** — pergunta a pasta do projeto (enter aceita a pasta atual; aceita `~`, caminho relativo ou absoluto) e o comando de inicialização. O comando vem sugerido: se houver `package.json`, o `pr` propõe `npm run dev`/`start`/`serve` conforme os scripts existentes; senão reconhece `manage.py`, `artisan`, `go.mod`, `Cargo.toml` ou `index.html` e sugere o comando típico de cada um. Enter aceita a sugestão.
- **criar subdomínio** — aponta `app.seudominio.com` para outro projeto. Veja [Subdomínios](#subdomínios).
- **conectar via Cloudflare** — publica o projeto por um túnel da Cloudflare, sem precisar de IP público nem das portas 80/443. Veja [Cloudflare Tunnel](#cloudflare-tunnel).

A marca tem 69 colunas: em terminal mais estreito que isso ela é omitida, porque cortada ao meio ficaria pior que ausente — o resto do cabeçalho continua igual.

O menu só abre quando há terminal de verdade. Num pipe ou script (`pr | cat`, cron), `pr` sozinho cai na tela de ajuda, para não travar esperando uma tecla. `pr menu` força o menu.

### Subir um projeto

```bash
cd meu-projeto
pr npm run dev
```

O nome do processo vem do nome da pasta. Funciona com **qualquer comando**, não só `npm`:

```bash
pr python3 -m http.server 3000
pr go run ./cmd/api
pr php artisan serve
pr start "npm run build && npm start" -n producao   # aspas quando tiver && | > etc.
pr start "node server.js" -n api --cwd /outro/caminho
```

Ao subir, o `pr` espera alguns segundos para descobrir em que porta o processo escutou e mostra:

```
╭─ meu-projeto iniciado ────────────────────────╮
│ comando  npm run dev                          │
│ pasta    ~/code/meu-projeto                   │
╰───────────────────────────────────────────────╯

  ✔ rodando em http://localhost:5173
  logs: pr logs meu-projeto -f   ·   parar: pr stop meu-projeto
```

### Ver o que está rodando

```bash
pr list
```

```
╭─ processos ──────────────────────────────────────────────────────────╮
│ ID  NOME          STATUS  PORTA  NO AR    MEM  RESTARTS  COMANDO      │
├──────────────────────────────────────────────────────────────────────┤
│  0  ● meu-projeto online   5173    12m  126MB         0  npm run dev  │
│  1  ● api         online   3000     4h   88MB         2  npm start    │
├──────────────────────────────────────────────────────────────────────┤
│ 2 no ar · 0 fora do ar                                               │
╰──────────────────────────────────────────────────────────────────────╯
```

### Falar com um processo específico

Todo comando que recebe um "alvo" aceita **nome, id numérico, ou um prefixo único do nome**:

```bash
pr stop api        # pelo nome
pr stop 0          # pelo id
pr stop me         # prefixo, se só houver um nome começando com "me"
pr restart all     # todos de uma vez
```

### Logs

```bash
pr logs api           # últimas 30 linhas
pr logs api -n 200    # últimas 200 linhas
pr logs api -f         # acompanha ao vivo (ctrl+c para sair)
```

### Parar, reiniciar, remover

```bash
pr restart api    # para e sobe de novo, com o mesmo comando/pasta/nome
pr stop api       # para, mas mantém na lista como "stopped" (dá pra reiniciar depois)
pr kill api       # apelido de stop
pr delete api     # para, tira da lista e apaga os logs
pr clean          # apaga da lista tudo que já estiver parado
```

## Domínio próprio e HTTPS

### Fluxo interativo

```bash
pr register
```

1. Mostra a lista de domínios já registrados, com o status de cada um.
2. Se houver projetos rodando, abre um seletor (setas ↑↓, enter escolhe, esc cancela).
3. Pede o domínio (aceita `meuapp.com.br` ou `https://meuapp.com.br`, normaliza sozinho).
4. Liga o domínio ao projeto escolhido e mostra os registros DNS a colar no seu registrador.
5. Sobe o proxy (se ainda não estiver no ar).

```
╭─ aponte meuapp.com.br para cá ────────────────────╮
│ Na Hostinger: Domínios → seu domínio → Zona DNS    │
│ No Registro.br: Meus domínios → DNS → Editar zona  │
│                                                    │
│ TIPO  NOME  VALOR            TTL                   │
│ A     @     203.0.113.45     3600                  │
│ A     www   203.0.113.45     3600                  │
╰────────────────────────────────────────────────────╯
```

Rodando `pr register` de novo (ou `pr domains`, que só lista) você vê a situação:

```
╭─ domínios ─────────────────────────────────────────────╮
│ DOMÍNIO          PROJETO    PORTA  SITUAÇÃO             │
├────────────────────────────────────────────────────────┤
│ ● meuapp.com.br  meu-app     3001  conectado            │
│ ● api.outro.com  api         4000  esperando o DNS      │
├────────────────────────────────────────────────────────┤
│ proxy no ar (pid 8123)                                  │
╰────────────────────────────────────────────────────────╯
```

| Bolinha | Significado |
| --- | --- |
| 🔴 vermelha | DNS ainda não aponta para cá, ou o projeto caiu |
| 🟡 amarela | DNS certo, certificado sendo emitido (ou um aviso a resolver, tipo registro A duplicado) |
| 🟢 verde | tudo pronto, servindo em `https://` |

### Regras de domínio ↔ projeto

- Um projeto pode ter **vários domínios** — registre cada um com `pr register`.
- Um domínio só pode apontar para **um** projeto por vez; registrar de novo escolhendo outro projeto **transfere** o domínio.
- O `www` é adicionado automaticamente quando faz sentido (não é adicionado se o domínio já começar com `www.` ou já tiver um subdomínio).
- Um subdomínio não registrado explicitamente (`api.meuapp.com.br`) cai no mesmo projeto do domínio pai (`meuapp.com.br`), a menos que você registre esse subdomínio para outro projeto — aí o casamento exato ganha do pai.

### Desligar um domínio

```bash
pr unregister meuapp.com.br    # ou: pr unlink
```

Remove o vínculo e apaga o certificado local.

### Controle do proxy

```bash
pr proxy status      # está no ar? em que ip e portas?
pr proxy start        # sobe (portas 80 e 443 por padrão)
pr proxy stop         # derruba
pr proxy logs [-f] [n]   # o que o proxy e o Let's Encrypt andam fazendo
```

### Portas privilegiadas (80/443)

Portas abaixo de 1024 exigem privilégio no Linux:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which node)   # libera o node, uma vez
pr proxy start
```

ou simplesmente `sudo pr proxy start`. Para testar sem tocar nada disso:

```bash
PR_HTTP_PORT=8080 PR_HTTPS_PORT=8443 pr proxy start
```

### O que o servidor precisa ter

- IP público alcançável da internet (o `pr proxy status` mostra o IP detectado);
- portas 80 e 443 abertas no firewall do sistema **e** no painel do provedor (security group / firewall do VPS — são coisas separadas);
- o projeto escutando em `0.0.0.0` ou `127.0.0.1`, na porta que aparece no `pr list`;
- **um único registro A** por domínio, apontando para o IP do servidor (dois registros A no mesmo nome fazem o Let's Encrypt sortear qual IP validar, e a emissão falha de forma intermitente — o `pr register` avisa isso na coluna de situação).

## Cloudflare Tunnel

É o segundo caminho para publicar um projeto — alternativa ao `pr register`. Em vez de o mundo bater na porta 80 do seu servidor, o `cloudflared` abre uma conexão de dentro para fora e a Cloudflare entrega o tráfego por ela.

Quando isso vale mais a pena que o `pr register`:

| | `pr register` (proxy próprio) | `pr cloudflare` (túnel) |
| --- | --- | --- |
| IP público no servidor | necessário | **dispensável** |
| portas 80/443 abertas | necessárias | **dispensáveis** |
| roda atrás de NAT/CGNAT, casa, Wi-Fi | não | **sim** |
| certificado | Let's Encrypt, emitido pelo `pr` | da Cloudflare, automático |
| domínio precisa estar | em qualquer registrador | **na Cloudflare** |
| dependência externa | nenhuma | `cloudflared` + conta Cloudflare |

### Usando

```bash
pr cloudflare          # ou pelo menu: pr → conectar via Cloudflare
```

Na primeira vez ele pede a credencial. Duas formas:

- **API Token** (recomendado) — crie em <https://dash.cloudflare.com/profile/api-tokens>, em *Create Custom Token*, com estas permissões:
  - `Account` · Cloudflare Tunnel · **Edit**
  - `Zone` · DNS · **Edit**
  - `Zone` · Zone · **Read**
- **Global API Key** — e-mail + chave; dá acesso total à conta, então prefira o token.

A credencial fica em `~/.pr/cloudflare.json` com permissão `600`. Ela é validada na hora (e a cada uso), e a conta é descoberta sozinha — se você tiver mais de uma, o `pr` pergunta qual.

Com a credencial no lugar, o fluxo é direto:

1. escolha o projeto (só aparecem os que estão no ar, com a porta detectada);
2. escolha o domínio (a lista vem das zonas ativas da sua conta Cloudflare);
3. informe o endereço — enter usa o domínio raiz, ou digite `app.seudominio.com`;
4. o `pr` faz o resto.

O "resto" é: baixar o `cloudflared` se faltar, criar o túnel na sua conta, gravar as credenciais e o `config.yml`, criar o registro `CNAME` apontando para `<id>.cfargotunnel.com` (proxied), e subir o conector como um processo gerenciado pelo próprio `pr`.

```
  → criando o túnel pr-meuapp
  → configuração escrita em ~/.pr/cloudflare/<id>.yml
  → apontando efflar.com para o túnel
  → subindo o conector

  ✔ https://efflar.com → meuapp (porta 5055)
```

### Comandos

| Comando | O que faz |
| --- | --- |
| `pr cloudflare` | o fluxo acima (apelido: `pr cf`) |
| `pr cloudflare list` | id, endereço, projeto, porta e estado de cada conector |
| `pr cloudflare sub` | cria um subdomínio num domínio de túnel — tudo automático |
| `pr cloudflare kill <id>` | desvincula o domínio do projeto (apelidos: `rm`, `delete`, `unlink`) |
| `pr cloudflare sync` | reescreve os túneis com as portas atuais e reinicia os conectores |
| `pr cloudflare login` | troca a credencial |
| `pr cloudflare logout` | apaga a credencial guardada |

```
╭─ cloudflare ──────────────────────────────────────────────╮
│ ID  ENDEREÇO          PROJETO  PORTA  SITUAÇÃO             │
├────────────────────────────────────────────────────────────┤
│  0  ● efflar.com      loja      5077  conectado            │
│  1  ● app.efflar.com  loja      5077  conectado            │
├────────────────────────────────────────────────────────────┤
│ conta Minha Conta  ·  desvincular: pr cloudflare kill <id> │
╰────────────────────────────────────────────────────────────╯
```

Na listagem, a bolinha diz o estado **real**, lido do log do conector:

| | significado |
| --- | --- |
| 🟢 verde | conexão registrada na borda da Cloudflare — está servindo |
| 🟡 amarelo | o conector subiu mas ainda não registrou (credencial recusada e rede bloqueada são as causas comuns) |
| 🔴 vermelho | o conector está parado, ou o projeto caiu |

### Subdomínios no túnel

```bash
pr cloudflare sub
```

É o mesmo fluxo do [`pr sub`](#subdomínios), mas listando **só** os domínios publicados por túnel — sem misturar com os do proxy. Escolha o domínio, digite o rótulo e diga qual projeto atende ali.

Nesse caminho **não sobra nada manual**: o `CNAME` do subdomínio é criado na sua zona da Cloudflare pela API, a rota entra no `config.yml`, e o conector do projeto escolhido sobe junto. Se o projeto ainda não tinha túnel, um é criado para ele (`pr-<projeto>`); se já tinha, a rota é acrescentada ao que existe.

### Desvinculando

```bash
pr cloudflare kill 1               # pelo id da lista
pr cloudflare kill app.efflar.com  # ou pelo endereço
pr cloudflare kill loja            # ou pelo nome do projeto
```

O que acontece, nessa ordem:

1. **o registro DNS é apagado na Cloudflare** — é isso que efetivamente tira o domínio do ar;
2. a rota some do `config.yml` do túnel;
3. se o túnel ainda serve outros endereços, o conector é reiniciado sem aquela rota;
4. se aquele era o último endereço, o conector é parado e removido, o túnel é apagado da sua conta e os arquivos locais dele somem.

O projeto em si continua rodando — sai só a ligação com o domínio. Para publicá-lo de novo, no mesmo domínio ou noutro, basta rodar `pr cloudflare`.

Sem credencial guardada, o `pr` avisa que o registro DNS ficou na Cloudflare e desfaz só o lado local.

### Como fica montado

O conector é um processo comum do `pr`, chamado `cf-<projeto>` — aparece no `pr list`, reinicia sozinho se cair, e `pr logs cf-<projeto> -f` mostra o que ele está fazendo.

```
~/.pr/
├── cloudflare.json              # credencial da conta (0600)
├── bin/cloudflared              # binário, se o pr precisou baixar
└── cloudflare/
    ├── tunnels.json             # vínculos: hostname → projeto, porta, túnel
    ├── <tunnel-id>.json         # credencial do túnel (0600)
    └── <tunnel-id>.yml          # ingress: hostname → http://localhost:porta
```

É **um túnel por projeto** (`pr-<projeto>`). Publicar um segundo endereço no mesmo projeto reaproveita o túnel e acrescenta a rota ao mesmo `config.yml`, preservando as anteriores.

O `cloudflared` é baixado sob demanda, direto do repositório oficial, para `~/.pr/bin` — sem `sudo` e sem disputar nada com o gerenciador de pacotes. Se você já tiver o `cloudflared` no `PATH`, o `pr` usa o seu.

### Atenção à porta

O `config.yml` aponta para a porta que o projeto tinha no momento da publicação. Se o projeto voltar numa porta diferente, o túnel passa a bater no lugar errado — rode:

```bash
pr cloudflare sync
```

Ele relê as portas atuais, reescreve os configs e reinicia os conectores que mudaram.

## Subdomínios

Com um domínio já publicado, `pr sub` aponta `app.seudominio.com` para **outro projeto**, rodando em outra porta.

```bash
pr sub
```

```
  de qual domínio quer criar um subdomínio?

  → efflar.com   site · porta 6001  proxy
    cancelar

  ? subdomínio de efflar.com: blog

  qual projeto vai responder em blog.efflar.com?

    site       porta 6001
  → blog       porta 6002
    cancelar

  ✔ blog.efflar.com → blog (porta 6002)
```

Para listar só os domínios de túnel, use `pr cloudflare sub` — o fluxo é o mesmo. A lista de partida do `pr sub` junta os dois caminhos de publicação — cada linha mostra o projeto, a porta e se veio do `pr register` (proxy) ou do `pr cloudflare` (túnel). O que acontece depois depende de qual for:

- **domínio do proxy** — o vínculo entra em `domains.json` na hora, e o roteamento passa a valer imediatamente. Falta só o registro `A` do subdomínio na sua zona DNS, que o `pr` mostra na tela; quando ele propagar, o certificado sai sozinho.
- **domínio de túnel** — não falta nada: o `CNAME` e a rota do túnel são criados na hora, pela API da Cloudflare, e o conector do projeto escolhido sobe automaticamente.

O rótulo é só o começo do endereço: digite `app`, não `app.seudominio.com`. Letras, números e hífen no meio, até 63 caracteres.

### Subdomínio não registrado

Vale saber que, no caminho do proxy, um subdomínio que você **não** registrou já cai no projeto do domínio pai:

```
efflar.com        → site  (registrado)
blog.efflar.com   → blog  (registrado com pr sub — o específico ganha)
outro.efflar.com  → site  (não registrado, cai no pai)
```

Então `pr sub` serve exatamente para o caso em que você quer que um subdomínio **específico** vá para outro lugar.

## Referência de comandos

A referência completa também está embutida no próprio programa:

```bash
pr help        # ou: pr --help, pr -h, pr (sem argumentos)
```

| Comando | Apelidos | O que faz |
| --- | --- | --- |
| `pr` | `menu` | abre o menu interativo |
| `pr <comando...>` | | roda o comando na pasta atual, em segundo plano |
| `pr start "<cmd>" -n <nome> [--cwd <pasta>]` | | mesmo, com nome e/ou pasta escolhidos |
| `pr list` | `ls`, `status` | processos, porta, uptime, memória, restarts |
| `pr info <alvo>` | `show` | detalhes de um processo, incluindo caminho do log |
| `pr logs <alvo> [-f] [-n N]` | `log` | log do processo |
| `pr restart <alvo\|all>` | | para e sobe de novo |
| `pr stop <alvo\|all>` | `kill` | para, mantém na lista |
| `pr delete <alvo\|all>` | `rm` | para, remove da lista e apaga logs |
| `pr clean` | | remove da lista tudo que já está parado |
| `pr register` | `domains` (só lista) | liga um domínio a um projeto |
| `pr sub` | `subdominio` | cria um subdomínio de um domínio já publicado |
| `pr unregister <dominio>` | `unlink` | desliga o domínio, apaga o certificado |
| `pr proxy status\|start\|stop\|logs` | | controla o proxy reverso |
| `pr cloudflare` | `cf` | publica por túnel da Cloudflare |
| `pr cloudflare list\|sync\|login\|logout` | | túneis e credencial da Cloudflare |
| `pr help` | `--help`, `-h` | esta referência |
| `pr --version` | | versão instalada |

## Variáveis de ambiente

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `PR_HOME` | `~/.pr` | onde guardar estado, logs e certificados |
| `PR_HTTP_PORT` | `80` | porta HTTP do proxy |
| `PR_HTTPS_PORT` | `443` | porta HTTPS do proxy |
| `PR_ACME_DIRECTORY` | produção do Let's Encrypt | outro servidor ACME — use o [staging](https://letsencrypt.org/docs/staging-environment/) para testar sem gastar a cota de emissão |
| `PR_CF_API` | `https://api.cloudflare.com/client/v4` | endereço da API da Cloudflare (serve para testar contra um mock) |
| `NO_COLOR` | — | desativa as cores no terminal |

## Onde tudo fica guardado, e o formato

Tudo dentro de `PR_HOME` (padrão `~/.pr`):

```
~/.pr/
├── procs/<nome>.json       # um arquivo por processo: pid, comando, cwd, status, restarts...
├── logs/<nome>.log         # stdout+stderr combinados
├── logs/<nome>-error.log   # só stderr
├── logs/_proxy.log         # log do proxy e das emissões ACME
├── domains.json            # [{ domain, process, www, createdAt, issuedAt, lastError }]
├── proxy.json              # { pid, startedAt, ports } — estado do daemon do proxy
├── acme-account.pem        # chave da conta ACME (criada na primeira emissão)
├── certs/<dominio>/
│   ├── key.pem
│   └── cert.pem
└── pages/                  # opcional: 404.html e 502.html personalizados (veja abaixo)
```

Nada disso é banco de dados — é tudo JSON simples e arquivos-texto, de propósito: dá para inspecionar e editar na mão em qualquer situação de emergência (`cat`, `jq`, um editor).

### Personalizar as páginas de erro do proxy

Quando alguém acessa um domínio não registrado (404) ou um projeto que caiu (502), o proxy mostra uma página com a identidade do PR System (fundo escuro, logo, explicação). Para usar a sua:

```bash
mkdir -p ~/.pr/pages
nano ~/.pr/pages/404.html    # e/ou 502.html
```

O proxy usa o arquivo assim que ele existir, sem precisar reiniciar.

## Como funciona por dentro

### Rodar um processo (`pr <comando>`)

1. `src/cli.js` interpreta os argumentos: se a primeira palavra não é um subcomando conhecido (`list`, `stop`...), trata tudo como o comando a rodar.
2. `src/runner.js#start()` monta o registro do processo (nome vindo da pasta ou de `-n`, id sequencial, comando, cwd) e grava em `~/.pr/procs/<nome>.json` via `src/store.js`.
3. Um **supervisor** (`src/supervisor.js`) é lançado **destacado** (`detached: true`, processo independente do terminal) rodando `node supervisor.js <nome>`.
4. O supervisor:
   - lê o registro, faz `spawn(comando, { shell: true, detached: true })` — o `detached` aqui cria um **grupo de processos próprio**, o que permite matar a árvore inteira depois (o `npm` e o `node` que ele lança por baixo, por exemplo);
   - direciona `stdout`/`stderr` para os arquivos de log;
   - ao sair o processo, decide: saída limpa (código 0) é fim normal; qualquer outra coisa dispara um **restart com backoff exponencial**, até 10 tentativas — depois disso marca como `errored` e desiste;
   - reage a `SIGTERM` derrubando a árvore inteira (`SIGTERM` no grupo, `SIGKILL` depois de um prazo se não sair).
5. `src/proc.js#ports()` descobre em que porta o processo escutou, cruzando a **árvore de pids reais** (lida de `/proc`) com a saída de `ss -tlnp` (ou `lsof` como alternativa). Se nada aparecer — um processo sem socket detectável —, cai para uma regex no log procurando algo como `http://localhost:PORT` ou `listening on port PORT`.

### Consultar o estado (`pr list`, `pr info`)

`src/runner.js#liveStatus()` e `#inspect()` **não confiam cegamente** no que está gravado no arquivo — conferem se o pid do supervisor e do processo ainda existem de verdade (`process.kill(pid, 0)`), porque a máquina pode ter reiniciado ou alguém pode ter matado o processo por fora. O status mostrado é sempre a realidade atual, reconciliada com o arquivo.

### Parar e reiniciar

`src/runner.js#stop()` manda `SIGTERM` para o **supervisor** (não para o processo em si) e espera; o supervisor é quem cuida de derrubar a árvore e atualizar o status. Isso evita a corrida entre "o supervisor tenta reiniciar" e "o usuário pediu para parar".

### O proxy reverso (`pr proxy start` / `pr register`)

1. `src/proxyctl.js#start()` lança `src/proxyd.js` como um processo destacado, que chama `src/proxy.js#createProxy()`.
2. `createProxy()` sobe **dois servidores**: um `http.Server` na porta 80 e um `https.Server` na porta 443 (com `SNICallback` para servir o certificado certo por domínio).
3. Roteamento: para cada requisição, `bindingFor(req.headers.host)` procura em `domains.json` um vínculo cujo domínio (ou `www.`, ou domínio pai de um subdomínio) bata com o `Host` recebido. Achando, descobre a porta do processo alvo (reaproveitando `src/proc.js`, com um cache de 5s para não chamar `ss` a cada requisição) e faz um `http.request` para `127.0.0.1:<porta>`, repassando o corpo e devolvendo a resposta — incluindo upgrade de conexão para WebSocket.
4. Sem vínculo → página 404 (`src/pages.js`); vínculo mas processo fora do ar → 502. Ambas em HTML para navegador (`Accept: text/html`) e texto puro para `curl`/scripts.
5. A cada 60 segundos (e também quando `domains.json` muda, com debounce de 2s), `reconcile()` passa por todo domínio registrado e chama `ensureCert()`.
6. `ensureCert()`: se já existe certificado válido com mais de 30 dias de validade, não faz nada (é a renovação automática). Senão, confere via DNS (`src/net.js#pointsHere()`) se o domínio já aponta para o IP público deste servidor — só então tenta emitir. Detecta também **registros A duplicados** e avisa em vez de tentar (metade das tentativas cairia no IP errado e falharia sem explicação aparente).
7. A emissão em si usa `src/acme.js` (protocolo ACME v2): cria/reaproveita uma conta, abre um pedido para os domínios, resolve o desafio **HTTP-01** (o proxy serve a resposta em `/.well-known/acme-challenge/<token>`, então essa validação só pode acontecer pela porta 80), gera um CSR (`src/asn1.js`, ASN.1 escrito à mão) e baixa o certificado assinado.
8. Se uma emissão falha, entra em backoff (5, 10, 20... até 60 minutos) para não estourar o limite de tentativas do Let's Encrypt (5 falhas/hora por domínio).

### Interface de terminal

`src/ui.js` implementa cores (RGB truecolor, com fallback e respeito a `NO_COLOR`), tabelas alinhadas por largura visível (ignorando os códigos de escape ANSI) e caixas com cantos arredondados. `src/prompt.js` implementa a seleção com setas e a leitura de texto direto do terminal em modo raw, sem nenhuma lib de terceiros.

## Mapa do código, arquivo por arquivo

| Arquivo | Linhas | Responsabilidade |
| --- | ---: | --- |
| `install.sh` | ~185 | instalador de uma linha |
| `bin/pr.js` | 8 | ponto de entrada do executável |
| `src/cli.js` | ~370 | interpreta argumentos, chama os comandos, monta as telas |
| `src/menu.js` | ~170 | a tela que aparece ao digitar `pr` sozinho (marca, opções) |
| `src/start.js` | ~70 | sobe um projeto e reporta (usado pelo CLI e pelo menu) |
| `src/runner.js` | ~150 | iniciar/parar/reiniciar/inspecionar processos |
| `src/supervisor.js` | ~122 | processo destacado que mantém um comando vivo |
| `src/proc.js` | ~171 | leitura de `/proc`, árvore de pids, portas em `LISTEN` |
| `src/store.js` | ~104 | leitura/escrita do estado em `~/.pr`, resolução de alvos |
| `src/proxy.js` | ~329 | o proxy reverso: roteamento, TLS, emissão/renovação |
| `src/proxyd.js` | 39 | entrada do daemon do proxy |
| `src/proxyctl.js` | ~87 | subir/parar/consultar o daemon do proxy |
| `src/acme.js` | ~236 | cliente do protocolo ACME v2 (Let's Encrypt) |
| `src/asn1.js` | 43 | codificador DER mínimo, usado para montar o CSR |
| `src/register.js` | ~289 | o comando `pr register` e a listagem de domínios |
| `src/sub.js` | ~215 | o comando `pr sub`, nos dois caminhos de publicação |
| `src/domains.js` | ~109 | leitura/escrita de `domains.json`, validação de domínio |
| `src/net.js` | ~87 | IP público do servidor, resolução DNS |
| `src/prompt.js` | ~121 | seleção com setas, leitura de texto no terminal |
| `src/ui.js` | ~144 | cores, tabelas, caixas |
| `src/pages.js` | ~147 | páginas HTML de erro (404/502) do proxy |
| `src/cftunnel.js` | ~370 | o fluxo do `pr cloudflare` |
| `src/cloudflare.js` | ~230 | cliente da API da Cloudflare e arquivos do túnel |
| `src/cloudflared.js` | ~100 | acha ou baixa o binário do cloudflared |
| `assets/logo.png` | — | logo usada nas páginas de erro |
| `test/pr.test.js` | — | testes (`node --test`) |

## Como mexer no código

### Rodando localmente sem instalar

```bash
node bin/pr.js list
node bin/pr.js npm run dev
```

Para isolar de um `~/.pr` real (útil ao testar), aponte `PR_HOME` para uma pasta temporária:

```bash
PR_HOME=/tmp/pr-teste node bin/pr.js list
```

### Testes

```bash
npm test
```

Cobrem: leitura de porta a partir do log (`portFromLog`), alinhamento de tabela ignorando escapes ANSI, normalização/validação de domínio, geração de hostnames (`www` automático), codificação de OID em ASN.1, e o CSR completo — validado contra o `openssl` quando disponível na máquina. O cliente ACME (`src/acme.js`) foi validado manualmente contra o ambiente de *staging* do Let's Encrypt (registro de conta, abertura de pedido, negociação de desafio).

Ao adicionar algo nesta área, o padrão do projeto é: nenhuma dependência nova, e cobrir com teste sempre que der para fazer sem subir um servidor de verdade.

### Onde adicionar algo novo

- **Novo subcomando** (tipo `pr algo`): adicione em `KNOWN` e no `switch` de `src/cli.js#main()`, e uma função `cmdAlgo()` ao lado das existentes. Adicione a linha correspondente em `help()`.
- **Nova opção no menu**: `src/menu.js#cmdMenu()` — acrescente um item na lista passada ao `select()` e trate o valor devolvido. A implementação do Cloudflare entra em `cloudflareSoon()`.
- **Mudar como uma porta é descoberta**: `src/proc.js#ports()` e `#portFromLog()`.
- **Mudar o comportamento de restart/backoff**: `src/supervisor.js`, constantes `MAX_RESTARTS` e `MIN_UPTIME_MS`.
- **Mudar o roteamento do proxy** (ex.: balanceamento entre várias portas do mesmo projeto): `src/proxy.js#bindingFor()` e `#targetPort()`.
- **Mexer no fluxo da Cloudflare**: `src/cftunnel.js` é o passo a passo interativo; `src/cloudflare.js` tem o cliente da API (todas as chamadas passam por `call()`) e a escrita do `config.yml`; `src/cloudflared.js` cuida do binário.
- **Trocar de certificado (outra CA)**: como o cliente ACME é padrão (RFC 8555), basta apontar `PR_ACME_DIRECTORY` para outro provedor compatível — não deveria precisar mexer em `src/acme.js`.
- **Mudar a aparência do terminal**: tudo centralizado em `src/ui.js` (cores) e `src/prompt.js` (interação).
- **Mudar as páginas de erro do proxy**: `src/pages.js`, ou pelo usuário final, via `~/.pr/pages/404.html` / `502.html`, sem mexer em código.

### Convenções do projeto

- **Zero dependências.** Qualquer necessidade (parse de flag, cores, prompt, ACME) é implementada no próprio código em vez de puxada do npm. Ao contribuir, mantenha essa regra a menos que haja uma conversa explícita sobre abrir exceção.
- **Node puro, sem build step.** ESM nativo (`type: module`), sem TypeScript, sem transpiler. `bin/pr.js` roda direto.
- **Comentários só quando explicam o "porquê"** (uma decisão não óbvia, uma limitação do SO, um workaround), nunca o "o quê" — o código já diz o que faz.
- **Todo texto voltado ao usuário é em português.**
- **Estado sempre em arquivo simples** (JSON, texto), nunca um banco embutido — para poder inspecionar e editar na mão em produção sem ferramenta extra.

## Problemas comuns

Veja a seção **Problemas comuns** do [README.md](README.md#problemas-comuns) para o passo a passo de cada um destes:

- `EEXIST: file already exists /usr/bin/pr` — conflito de nome com o coreutils.
- `EACCES` ao subir o proxy — porta privilegiada sem `setcap`/root.
- A bolinha do domínio não fica verde — DNS não propagado, registro A duplicado, proxy/CDN do registrador ligado, porta 80 fechada no firewall, ou limite de tentativas do Let's Encrypt.
- `502` no navegador — processo caiu ou não abriu porta.
- `404 nenhum projeto registrado` — acesso pelo IP puro ou domínio não registrado (mostra a página de apresentação do PR System).
- Processos somem depois de reiniciar o VPS — ainda não há integração com systemd (veja Limitações).

## Segurança

- O `pr` roda com os privilégios de quem o chama. Rodar `pr proxy start` como root (ou com `setcap` no node) é necessário só por causa das portas 80/443 — os projetos em si não precisam de privilégio nenhum.
- Os certificados privados ficam em `~/.pr/certs/<domínio>/key.pem`, gravados com permissão restrita; o mesmo vale para a chave da conta ACME (`~/.pr/acme-account.pem`).
- O proxy só encaminha para `127.0.0.1`, nunca expõe as portas internas dos projetos diretamente — quem chega de fora só enxerga 80/443.
- Nomes de processo são sanitizados (`src/store.js#safeName()`) antes de virarem nome de arquivo, para não permitir escapar do diretório de estado.
- O instalador (`install.sh`) é um script de shell obtido por `curl | sh` — como qualquer instalador nesse formato (incluindo o do próprio Node/nvm), vale a prática de ler o script antes de rodar em produção: `curl -fsSL .../install.sh | less`.

## Limitações conhecidas

- **Não sobrevive a reboot.** Nem os processos gerenciados nem o proxy voltam sozinhos depois de reiniciar o servidor — é preciso rodar `pr proxy start` e subir os projetos de novo manualmente. Não há hoje um `pr startup` que gere uma unit systemd (é o próximo passo natural, se for necessário).
- **Só Linux.** A descoberta de porta depende de `/proc` e do comando `ss` (com `lsof` como alternativa).
- **Uma porta por processo é assumida no proxy** — não há balanceamento entre múltiplas instâncias do mesmo projeto.
- **DNS é responsabilidade do usuário** no caminho do `pr register`: o `pr` não mexe na zona pelo provedor (Hostinger/Registro.br/etc), apenas mostra o que colar e confere se já resolve. No caminho da Cloudflare o registro é criado automaticamente, porque ali existe API.
- **O túnel aponta para uma porta fixa.** Se o projeto reiniciar noutra porta, é preciso `pr cloudflare sync`.
- **O caminho da Cloudflare exige o domínio na Cloudflare** (nameservers dela), e o conector depende do binário `cloudflared`.
