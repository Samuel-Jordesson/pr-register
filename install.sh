#!/bin/sh
# Instalador do pr — baixa, instala e cria o comando `pr`.
#
#   curl -fsSL https://pr.sh | sh          (se você tiver um domínio apontado)
#   curl -fsSL https://raw.githubusercontent.com/Samuel-Jordesson/pr-register/main/install.sh | sh
#
# Variáveis aceitas:
#   PR_PREFIX=/usr/local   onde instalar (padrão: /usr/local com sudo, ~/.local sem)
#   PR_REF=main            branch, tag ou commit a instalar
#   PR_SETCAP=1            já libera as portas 80/443 para o node
#   PR_NODE=1              instala o Node via nvm se estiver faltando

set -eu

REPO="Samuel-Jordesson/pr-register"
REF="${PR_REF:-main}"
MIN_NODE=20

# ── aparência ────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  ACCENT=$(printf '\033[38;2;217;119;87m')
  DIM=$(printf '\033[38;2;138;133;126m')
  RED=$(printf '\033[38;2;206;92;92m')
  GREEN=$(printf '\033[38;2;122;176;122m')
  RESET=$(printf '\033[0m')
else
  ACCENT='' DIM='' RED='' GREEN='' RESET=''
fi

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s→%s %s\n' "$ACCENT" "$RESET" "$1"; }
good() { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$RED" "$RESET" "$1"; }
die()  { printf '  %s✖%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# ── verificações ─────────────────────────────────────────────────────────

[ "$(uname -s)" = "Linux" ] || die "o pr só roda em Linux (usa /proc e ss para achar as portas)"

have() { command -v "$1" >/dev/null 2>&1; }

install_node() {
  step "instalando o Node via nvm"
  have curl || die "preciso do curl para instalar o Node"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null 2>&1
  # shellcheck disable=SC1090
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm install --lts >/dev/null 2>&1
}

node_version() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

if ! have node; then
  if [ "${PR_NODE:-0}" = "1" ]; then
    install_node
  else
    die "não achei o Node. Instale o Node 20+ ou rode de novo com PR_NODE=1 para eu instalar"
  fi
fi

MAJOR=$(node_version)
if [ -z "$MAJOR" ] || [ "$MAJOR" -lt "$MIN_NODE" ]; then
  if [ "${PR_NODE:-0}" = "1" ]; then
    install_node
    MAJOR=$(node_version)
  fi
  [ "${MAJOR:-0}" -ge "$MIN_NODE" ] || die "o pr precisa do Node $MIN_NODE ou mais novo (você tem $(node -v 2>/dev/null || echo nenhum))"
fi

NODE_BIN=$(command -v node)

# ── onde instalar ────────────────────────────────────────────────────────

SUDO=''
if [ -n "${PR_PREFIX:-}" ]; then
  PREFIX="$PR_PREFIX"
elif [ "$(id -u)" = "0" ]; then
  PREFIX=/usr/local
elif have sudo; then
  PREFIX=/usr/local
  SUDO=sudo
else
  PREFIX="$HOME/.local"
fi

# se não der para escrever no prefixo escolhido, cai para a pasta do usuário
if ! $SUDO mkdir -p "$PREFIX/lib" "$PREFIX/bin" 2>/dev/null; then
  PREFIX="$HOME/.local"
  SUDO=''
  mkdir -p "$PREFIX/lib" "$PREFIX/bin"
fi

LIB="$PREFIX/lib/pr-register"
BIN="$PREFIX/bin/pr"

printf '\n  %spr%s %s— instalando%s\n\n' "$ACCENT" "$RESET" "$DIM" "$RESET"
say "${DIM}node    $NODE_BIN ($(node -v))${RESET}"
say "${DIM}destino $LIB${RESET}"
printf '\n'

# ── baixar ───────────────────────────────────────────────────────────────

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

if have git; then
  step "baixando o código (git, ref $REF)"
  git clone --depth 1 --branch "$REF" -q "https://github.com/$REPO.git" "$TMP/src" 2>/dev/null ||
    git clone --depth 1 -q "https://github.com/$REPO.git" "$TMP/src"
elif have curl && have tar; then
  step "baixando o código (tarball, ref $REF)"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TMP/pr.tar.gz"
  mkdir -p "$TMP/src"
  tar -xzf "$TMP/pr.tar.gz" -C "$TMP/src" --strip-components=1
else
  die "preciso do git, ou de curl + tar, para baixar"
fi

[ -f "$TMP/src/bin/pr.js" ] || die "o download veio incompleto"

# ── instalar ─────────────────────────────────────────────────────────────

step "instalando em $LIB"
$SUDO rm -rf "$LIB"
$SUDO mkdir -p "$LIB"
$SUDO cp -R "$TMP/src/bin" "$TMP/src/src" "$TMP/src/assets" "$TMP/src/package.json" "$LIB/"
[ -f "$TMP/src/README.md" ] && $SUDO cp "$TMP/src/README.md" "$LIB/"

# O comando é um lançador que fixa o node usado na instalação: assim o `pr`
# funciona com sudo, com nvm e sem depender do prefixo global do npm — e sem
# tocar no /usr/bin/pr do coreutils.
step "criando o comando pr"
$SUDO sh -c "cat > '$BIN'" <<LAUNCHER
#!/bin/sh
exec "$NODE_BIN" "$LIB/bin/pr.js" "\$@"
LAUNCHER
$SUDO chmod 755 "$BIN"

VERSION=$("$BIN" --version 2>/dev/null || echo 'pr ?')
good "$VERSION instalado em $BIN"

# ── portas 80 e 443 ──────────────────────────────────────────────────────

if [ "${PR_SETCAP:-0}" = "1" ]; then
  if have setcap; then
    step "liberando as portas 80 e 443 para o node"
    $SUDO setcap 'cap_net_bind_service=+ep' "$NODE_BIN" && good "node pode abrir portas baixas"
  else
    warn "setcap não encontrado (instale o pacote libcap2-bin)"
  fi
fi

# ── avisos finais ────────────────────────────────────────────────────────

printf '\n'

case ":$PATH:" in
  *":$PREFIX/bin:"*)
    if [ "$(command -v pr)" != "$BIN" ]; then
      warn "outro pr vem antes no PATH: $(command -v pr)"
      say "${DIM}coloque $PREFIX/bin na frente, ou chame $BIN direto${RESET}"
      printf '\n'
    fi
    ;;
  *)
    warn "$PREFIX/bin não está no PATH. Acrescente ao seu shell:"
    say "${DIM}echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.bashrc && exec bash${RESET}"
    printf '\n'
    ;;
esac

say "${DIM}comece por aqui:${RESET}"
say "  ${ACCENT}pr help${RESET}                    ${DIM}todos os comandos${RESET}"
say "  ${ACCENT}pr npm run dev${RESET}             ${DIM}sobe o projeto da pasta atual${RESET}"
say "  ${ACCENT}pr register${RESET}                ${DIM}publica num domínio seu, com https${RESET}"
printf '\n'

if [ "${PR_SETCAP:-0}" != "1" ]; then
  say "${DIM}para o proxy atender nas portas 80 e 443:${RESET}"
  say "  ${DIM}sudo setcap 'cap_net_bind_service=+ep' $NODE_BIN${RESET}"
  say "  ${DIM}pr proxy start${RESET}"
  printf '\n'
fi
