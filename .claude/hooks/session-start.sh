#!/usr/bin/env bash
#
# SessionStart hook. It provisions the toolchain the gate needs, so a web
# session can run `pnpm check` and `pnpm check:lemmascript`. The work runs
# only on the web; a local session runs `scripts/setup.sh` by hand.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

"${CLAUDE_PROJECT_DIR:-.}/scripts/setup.sh"
