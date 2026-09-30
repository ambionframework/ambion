#!/usr/bin/env bash
# Run the provisioned workstation OpenSSH tier in an isolated Docker Linux host.
set -euo pipefail

IMAGE='node:26.10-bookworm'
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONTAINER="ambion-live-local-workstation-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
	local status=$?
	trap - EXIT HUP INT TERM
	if [ "$(docker inspect --format '{{ index .Config.Labels "org.ambion.local-workstation-run" }}' \
		"$CONTAINER" 2>/dev/null || true)" = "$CONTAINER" ]; then
		docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
	fi
	exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! command -v docker >/dev/null 2>&1; then
	echo 'test:live-local-workstation: Docker is required; install or start Docker and retry.' >&2
	exit 1
fi
if ! docker info >/dev/null 2>&1; then
	echo 'test:live-local-workstation: Docker is unavailable; start its daemon and retry.' >&2
	exit 1
fi
PNPM_VERSION="$(node -e '
	const fs = require("node:fs");
	const packageManager = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager;
	if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
		process.exit(1);
	}
	process.stdout.write(packageManager.slice("pnpm@".length));
' "$REPO/package.json")"

echo "Starting isolated Linux workstation fixture ($IMAGE)."
docker run --detach --name "$CONTAINER" \
	--label "org.ambion.local-workstation-run=$CONTAINER" \
	--mount "type=bind,source=$REPO,target=/host,readonly" \
	"$IMAGE" sleep infinity >/dev/null

docker exec "$CONTAINER" bash -lc '
	set -euo pipefail
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
		acl curl git openssh-client openssh-server
	npm install --global pnpm@'"$PNPM_VERSION"'
	mkdir -p /workspace
	tar \
		--exclude=.git --exclude='*/.git' \
		--exclude=node_modules --exclude='*/node_modules' \
		--exclude=.codex --exclude=.claude \
		--exclude=dist --exclude='*/dist' \
		--exclude=.turbo --exclude='*/.turbo' \
		--exclude=.cache --exclude='*/.cache' \
		--exclude=coverage --exclude='*/coverage' \
		--exclude=.env* --exclude='*/.env*' \
		-C /host -cf - . | tar -xf - -C /workspace
	cd /workspace
	pnpm --version
	pnpm install --frozen-lockfile
	bash packages/workstation/test/sshd/setup.sh /tmp/ambion-sshd
	AMBION_WORKSTATION_SSHD=/tmp/ambion-sshd/workstation.json \
		pnpm --filter @ambionframework/workstation run test:sshd
'

echo 'Local workstation OpenSSH integration tier passed.'
