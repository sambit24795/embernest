#!/bin/sh
# Embernest installer for Linux and macOS.
#   curl -fsSL https://raw.githubusercontent.com/sambit24795/embernest/main/install/install.sh | sh
#
# Environment (all optional):
#   EMBERNEST_HOME               data folder (default: the OS default)
#   EMBERNEST_VERSION            npm version or tag of the embernest package to install (default: latest)
#   EMBERNEST_SOURCE             install from this instead of the npm registry: a local .tgz
#                                path, or a tarball URL such as
#                                https://codeload.github.com/sambit24795/embernest/tar.gz/main
#   EMBERNEST_BIN_DIR            where the `embernest` shim goes (default: ~/.local/bin)
#   EMBERNEST_NO_SETUP=1         do not run `embernest setup` at the end
#   EMBERNEST_FORCE_NODE_DOWNLOAD=1  ignore any Node on PATH (used for testing)
# The old PIXELKILN_* names are still accepted. An existing PixelKiln data folder is reused.
set -eu

REPO="sambit24795/embernest"

# Settings are read as EMBERNEST_*; the old PIXELKILN_* names still work.
# shellcheck disable=SC2154  # _new/_old are set by eval
env_or_legacy() { # env_or_legacy SUFFIX -> value of EMBERNEST_SUFFIX, else PIXELKILN_SUFFIX
  eval "_new=\${EMBERNEST_$1:-}"
  if [ -n "$_new" ]; then printf '%s' "$_new"; return; fi
  eval "_old=\${PIXELKILN_$1:-}"
  printf '%s' "$_old"
}

# Node LTS ("Krypton" 24.x) from https://nodejs.org/dist/index.json; any Node >= 22 works.
NODE_VERSION="24.21.0"
NODE_MIN_MAJOR=22

say() { printf '%s\n' "$*"; }
die() { printf 'embernest install: %s\n' "$*" >&2; exit 1; }

# --- 1. OS and architecture -------------------------------------------------
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS '$(uname -s)'. Use install.ps1 on Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture '$(uname -m)'." ;;
esac

# --- 2. Data folder ---------------------------------------------------------
# Order: EMBERNEST_HOME, PIXELKILN_HOME, the new default if it exists, an existing
# PixelKiln folder (kept in place, never moved), else the new default.
if [ "$OS" = darwin ]; then
  NEW_HOME="$HOME/Library/Application Support/Embernest"
  OLD_HOME="$HOME/Library/Application Support/PixelKiln"
else
  NEW_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/embernest"
  OLD_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pixelkiln"
fi
HOME_DIR=$(env_or_legacy HOME)
if [ -z "$HOME_DIR" ]; then
  if [ -d "$NEW_HOME" ]; then HOME_DIR="$NEW_HOME"
  elif [ -d "$OLD_HOME" ]; then HOME_DIR="$OLD_HOME"
  else HOME_DIR="$NEW_HOME"
  fi
fi
BIN_DIR=$(env_or_legacy BIN_DIR)
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$HOME_DIR"

# --- helpers ----------------------------------------------------------------
fetch() { # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget to download files."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "need sha256sum or shasum to verify the Node download."
  fi
}

system_node_ok() {
  [ "$(env_or_legacy FORCE_NODE_DOWNLOAD)" = 1 ] && return 1
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

install_private_node() {
  name="node-v$NODE_VERSION-$OS-$ARCH"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  tmp=$(mktemp -d)
  say "Downloading Node.js v$NODE_VERSION ($OS-$ARCH)..."
  fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz"
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  want=$(grep "  $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d ' ' -f 1)
  [ -n "$want" ] || { rm -rf "$tmp"; die "no checksum for $name.tar.gz in SHASUMS256.txt."; }
  got=$(sha256_of "$tmp/$name.tar.gz")
  if [ "$got" != "$want" ]; then
    rm -rf "$tmp"
    die "checksum mismatch for $name.tar.gz (expected $want, got $got)."
  fi
  say "Checksum OK."
  rm -rf "$HOME_DIR/node"
  mkdir -p "$HOME_DIR/node"
  tar -xzf "$tmp/$name.tar.gz" -C "$HOME_DIR/node" --strip-components=1 \
    || { rm -rf "$tmp"; die "could not extract Node (is 'tar' with gzip support installed?)."; }
  rm -rf "$tmp"
}

# --- 3. Node ----------------------------------------------------------------
if system_node_ok; then
  NODE=$(command -v node)
  NPM=$(command -v npm)
  say "Using Node $(node -v) at $NODE"
else
  install_private_node
  NODE="$HOME_DIR/node/bin/node"
  NPM="$HOME_DIR/node/bin/npm"
  # npm's shebang is `#!/usr/bin/env node`, so the private node must be on PATH.
  PATH="$HOME_DIR/node/bin:$PATH"
  export PATH
fi

# --- 4. Embernest -----------------------------------------------------------
# From the npm registry unless EMBERNEST_SOURCE points at a tarball (local or URL).
SPEC=$(env_or_legacy SOURCE)
if [ -z "$SPEC" ]; then
  REF=$(env_or_legacy VERSION)
  SPEC="embernest@${REF:-latest}"
fi
say "Installing $SPEC into $HOME_DIR/app ..."
"$NPM" install -g --prefix "$HOME_DIR/app" --no-fund --no-audit "$SPEC"

ENTRY="$HOME_DIR/app/lib/node_modules/embernest/bin/embernest.js"
[ -f "$ENTRY" ] || die "install finished but $ENTRY is missing."

# --- 5. Shim ----------------------------------------------------------------
mkdir -p "$BIN_DIR"
{
  printf '#!/bin/sh\n'
  printf 'exec "%s" "%s" "$@"\n' "$NODE" "$ENTRY"
} > "$BIN_DIR/embernest"
chmod 755 "$BIN_DIR/embernest"
# Keep the old command name working too.
cp "$BIN_DIR/embernest" "$BIN_DIR/pixelkiln"
chmod 755 "$BIN_DIR/pixelkiln"
say "Installed $BIN_DIR/embernest (and $BIN_DIR/pixelkiln as an alias)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add it with:"
    case "${SHELL:-}" in
      */fish) say "  fish_add_path \"$BIN_DIR\"" ;;
      */zsh)  say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
      *)      say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
    esac
    say "then open a new terminal."
    ;;
esac

# --- 6. Setup ---------------------------------------------------------------
if [ "$(env_or_legacy NO_SETUP)" = 1 ]; then
  say "Skipping setup. Run 'embernest setup' when you are ready."
  exit 0
fi
# Under `curl | sh` stdin is the script, so setup reads answers from the terminal.
say "Docs: https://github.com/$REPO#readme"
if ( : </dev/tty ) 2>/dev/null; then
  "$BIN_DIR/embernest" setup </dev/tty
else
  say "No terminal available. Run 'embernest setup' yourself."
fi
