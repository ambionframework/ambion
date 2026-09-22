#!/usr/bin/env bash
#
# Provision the full local toolchain for the gate.
#
# `pnpm check` needs Node 26.4.0 or newer, because `examples/workbench`
# depends on `@opentui/core`, which sets that engine floor, and `.npmrc` sets
# `engine-strict=true`. Every library package needs only Node 22.19.0 or
# newer; this script installs the higher, development version, because it
# can run everything the lower one can. `pnpm check:lemmascript` needs Dafny
# and Z3, because `lsc check --backend=dafny` verifies the rules. This script
# installs all four and installs the workspace dependencies.
#
# The script is idempotent. It skips a tool that is already present. Run it by
# hand for local development, or let the SessionStart hook run it on the web.
# When `CLAUDE_ENV_FILE` is set, the script appends the tool paths to it, so
# every later shell in the session finds Node, Dafny, and Z3.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-26.4.0}"
DOTNET_CHANNEL="${DOTNET_CHANNEL:-8.0}"
DAFNY_VERSION="${DAFNY_VERSION:-4.11.0}"
Z3_VERSION="${Z3_VERSION:-4.12.1.0}"

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
log() { printf '[setup] %s\n' "$*" >&2; }

# --- Node, through nvm ---
# The web image ships nvm. `nvm.sh` sits under one of a few paths.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
for candidate in "$NVM_DIR/nvm.sh" /opt/nvm/nvm.sh /usr/local/nvm/nvm.sh; do
	if [ -s "$candidate" ]; then
		# shellcheck disable=SC1090
		. "$candidate"
		break
	fi
done
if command -v nvm >/dev/null 2>&1; then
	nvm install "$NODE_VERSION" >/dev/null
	nvm use "$NODE_VERSION" >/dev/null
	NODE_BIN="$(dirname "$(nvm which "$NODE_VERSION")")"
else
	log "nvm is absent; the current node is $(node --version 2>/dev/null || echo none)"
	NODE_BIN="$(dirname "$(command -v node)")"
fi
export PATH="$NODE_BIN:$PATH"
log "node $(node --version)"

# --- Workspace dependencies ---
# `install` reuses the store between runs; the container caches the result.
( cd "$ROOT" && pnpm install --frozen-lockfile )

# --- .NET, Dafny, and Z3, for the Dafny gate ---
export DOTNET_ROOT="$HOME/.dotnet"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
if [ ! -x "$DOTNET_ROOT/dotnet" ]; then
	log "installing .NET $DOTNET_CHANNEL"
	curl -fsSL https://dot.net/v1/dotnet-install.sh |
		bash -s -- --channel "$DOTNET_CHANNEL" --install-dir "$DOTNET_ROOT"
fi
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
if ! command -v dafny >/dev/null 2>&1; then
	log "installing Dafny $DAFNY_VERSION"
	dotnet tool install --global dafny --version "$DAFNY_VERSION"
fi

# The Dafny tool package omits Z3. Dafny 4.11 reads Z3 4.12.1, which pip ships.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v z3 >/dev/null 2>&1; then
	log "installing Z3 $Z3_VERSION"
	pip3 install --user "z3-solver==$Z3_VERSION" >/dev/null 2>&1 ||
		pip3 install --user --break-system-packages "z3-solver==$Z3_VERSION" >/dev/null
fi
log "dafny $(dafny --version) | $(z3 --version)"

# --- Persist the tool paths for the rest of the session ---
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
	{
		echo "export DOTNET_ROOT=\"$DOTNET_ROOT\""
		echo "export PATH=\"$NODE_BIN:$DOTNET_ROOT:$DOTNET_ROOT/tools:$HOME/.local/bin:\$PATH\""
	} >>"$CLAUDE_ENV_FILE"
fi

log "ready. Run 'pnpm check' and 'pnpm check:lemmascript'."
