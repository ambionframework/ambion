#!/usr/bin/env bash
# Provision a workstation on this machine for the integration tier, and
# start an OpenSSH server for it. Run it as root:
#
#   sudo bash packages/workstation/test/sshd/setup.sh <state-dir>
#
# The script makes one account and one key for each agent the tier uses,
# one group for all of them, the audit folder and the rooms folder, and an
# `sshd` on 127.0.0.1:2222. It also makes the git account `lab-git` of
# `workstationGitBackend` outside the group, with the `Match` block that
# adds `authorized_keys.ambion`. `sshd` also listens on the machine's own
# address, so a test can connect from a source other than the loopback
# address. The script writes `<state-dir>/workstation.json`, and the tier
# reads that file from `AMBION_WORKSTATION_SSHD`. Run it on a machine you
# can throw away, such as a CI runner or a container: it adds users and
# writes under /srv.
set -euo pipefail

STATE="${1:?usage: setup.sh <state-dir>}"
PORT=2222
GROUP=ambion-lab
ACCOUNTS=(conformance surveyor planner analyst reviewer lab-host)
GIT_ACCOUNT=lab-git
ROOT=/srv/ambion/lab

if [ "$(id -u)" -ne 0 ]; then
	echo "setup.sh: run as root" >&2
	exit 1
fi

if ! [ -x /usr/sbin/sshd ] || ! command -v ssh >/dev/null || ! command -v git >/dev/null ||
	! command -v setfacl >/dev/null; then
	apt-get update -q
	DEBIAN_FRONTEND=noninteractive apt-get install -y -q openssh-server openssh-client git acl
fi

# The first address of this machine that is not a loopback address. A
# connection from this machine to that address has it as its source.
EXTERNAL="$(hostname -I | tr ' ' '\n' | grep -v -e '^$' -e '^127\.' -e '^::1$' -e ':' | head -n 1 || true)"
if [ -z "$EXTERNAL" ]; then
	echo "setup.sh: this machine has no IPv4 address other than the loopback address" >&2
	exit 1
fi

mkdir -p "$STATE/keys" /run/sshd
getent group "$GROUP" >/dev/null || groupadd "$GROUP"

# Make the account `$1` with a home of mode 0700, and give the host a key
# for it. The other arguments go to `useradd`.
account() {
	local name="$1" home
	shift
	id "$name" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$@" "$name"
	# `useradd` locks the password with `!`, and an `sshd` without PAM
	# refuses a locked account for every method. `*` sets no password and
	# does not lock the account.
	usermod --password '*' "$name"
	home="$(getent passwd "$name" | cut -d: -f6)"
	chmod 0700 "$home"
	rm -f "$STATE/keys/$name" "$STATE/keys/$name.pub"
	ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$STATE/keys/$name"
	install -d -m 0700 -o "$name" -g "$name" "$home/.ssh"
	install -m 0600 -o "$name" -g "$name" "$STATE/keys/$name.pub" "$home/.ssh/authorized_keys"
}

for name in "${ACCOUNTS[@]}"; do
	account "$name" --groups "$GROUP"
done
# The git account is not in the agents' group. It writes no audit entry
# and no room mirror.
account "$GIT_ACCOUNT"

# Every agent writes the audit log as itself. The setgid bit keeps the
# group on each new file, and the default ACL keeps it writable for the
# group whatever umask the SFTP server has.
install -d -m 2770 -o root -g "$GROUP" "$ROOT/audit"
setfacl -d -m g::rw "$ROOT/audit"
# Only the host account writes the room mirror. The agents read it.
install -d -m 2750 -o lab-host -g "$GROUP" "$ROOT/rooms"

rm -f "$STATE/ssh_host_ed25519_key" "$STATE/ssh_host_ed25519_key.pub"
ssh-keygen -q -t ed25519 -N '' -f "$STATE/ssh_host_ed25519_key"
# A `Match` block holds every line after it, so it comes last.
cat >"$STATE/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
ListenAddress $EXTERNAL
HostKey $STATE/ssh_host_ed25519_key
PidFile $STATE/sshd.pid
UsePAM no
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers ${ACCOUNTS[*]} $GIT_ACCOUNT
Subsystem sftp internal-sftp
Match User $GIT_ACCOUNT
	AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.ambion
EOF

if [ -f "$STATE/sshd.pid" ]; then
	kill "$(cat "$STATE/sshd.pid")" 2>/dev/null || true
	sleep 0.5
fi
/usr/sbin/sshd -t -f "$STATE/sshd_config"
/usr/sbin/sshd -f "$STATE/sshd_config" -E "$STATE/sshd.log"

fingerprint="$(ssh-keygen -lf "$STATE/ssh_host_ed25519_key.pub" | cut -d' ' -f2)"
cat >"$STATE/workstation.json" <<EOF
{
	"host": "127.0.0.1",
	"port": $PORT,
	"hostKey": "$fingerprint",
	"external": "$EXTERNAL",
	"keys": "$STATE/keys",
	"layout": { "audit": "$ROOT/audit/audit.jsonl", "rooms": "$ROOT/rooms" }
}
EOF

# The tier runs as the user that called sudo, and it reads the keys.
if [ -n "${SUDO_USER:-}" ]; then
	chown -R "$SUDO_USER" "$STATE/keys" "$STATE/workstation.json"
fi
echo "workstation: $STATE/workstation.json"
