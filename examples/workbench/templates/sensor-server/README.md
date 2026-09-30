# Sensor server

This template serves deterministic numeric, frame, and text fixtures. It
needs Node 22.19 or newer, Git, and npm. It needs no hardware, model
provider, framework daemon, or ffmpeg. The sensor wire schemas come from
`@ambionframework/workspace/sensors`; the template does not copy their
definitions.

## Fork and install

Fork `templates/sensor-server` and clone it into your home with the
workspace Git tool. Start a branch before editing:

```ts
fork({ source: 'templates/sensor-server', name: 'bench-sensors', clone: '~/sensor-server' });
bash({ command: 'cd ~/sensor-server && git switch -c sensing' });
```

Install the sensor API package by building and packing it from the SN1
commit, `ccaf45bf42eaef98c36841e133810232b24fced2`. The published 0.4.0
package does not include SN1, and the GitHub Packages registry is not a
substitute for this local build. Keep the tarball outside the sensor
checkout and reuse that exact artifact after cloning elsewhere; rebuilding
from a moving checkout can silently change the package contents.

```sh
cd /path/to/ambion
git rev-parse HEAD  # use ccaf45bf42eaef98c36841e133810232b24fced2
pnpm install
mkdir -p /tmp/ambion-packages
pnpm --dir packages/workspace build
pnpm --dir packages/workspace pack --pack-destination /tmp/ambion-packages
cd ~/sensor-server
npm install --no-save --package-lock=false typebox@1.3.34 /tmp/ambion-packages/ambionframework-workspace-0.4.0.tgz
```

The template declares `typebox` as a direct, pinned dependency because
`server.mjs` imports `typebox/value` directly. The install resolves that
dependency along with the workspace tarball. `--no-save` and
`--package-lock=false` keep the machine-local tarball path out of the fork's
manifest and lockfile. After cloning elsewhere, install from that same
preserved tarball; only rebuild it when deliberately changing the workspace
API artifact.

Set `AMBION_SENSOR_REPOSITORY` to the fork's lowercase `namespace/name`
if the `origin` remote cannot provide it. Otherwise the server reads the
repository identifier from `origin`.

## Customize and validate

Edit `server.mjs` to change the fixture observations. Numeric values use a
series part, frame bytes live in `fixtures/frame.png`, and text uses a text
part. Keep timestamps in UTC with three millisecond digits and validate
every response against `@ambionframework/workspace/sensors`. The fixtures
are deterministic; span requests return `422` because all three index
entries declare `spans: false`.

Run the template tests after making a change:

```sh
npm test
```

The tests exercise the real HTTP server, schema validation, retained file
digests, bad requests, launch metadata, and the external data directory.
The SN4 `sensorConformance` runner is not implemented yet, so `npm test`
does not claim conformance-runner coverage or Git push/reclone acceptance.

After the tests pass, commit and push the branch before starting the saved
version:

```sh
git add server.mjs fixtures
git commit -m 'Customize sensor fixtures'
git push -u origin HEAD
```

## Start in a workspace

Start the server as a foreground workspace process. The workspace `bash`
tool runs it in the background and returns a process handle:

```ts
bash({
  command:
    'cd ~/sensor-server && AMBION_SENSOR_REPOSITORY=instruments/bench-sensors ' +
    'AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench" PORT=0 node server.mjs',
  name: 'bench-sensors',
  wait: 0,
  timeout: 86400,
});
// Result: process bash-1a2b3c4d5e6f.
status({ handle: 'bash-1a2b3c4d5e6f' });
// Read READY http://127.0.0.1:<port> from the process output.
```

The server uses `PORT` when set and otherwise requests port zero, so the
operating system selects a free port. It binds to workstation
`127.0.0.1`. It writes the fixture acquisition files before printing
`READY http://127.0.0.1:<port>`. Use that port and the process handle in
the workspace `connect` call, available on a backend with port support.
Then use `observe` to retain the measurements and referenced files.

The `GET /` index captures the repository, full commit, branch when
attached, and dirty flag once at startup. A detached checkout omits the
branch. The dirty flag includes staged, unstaged, and untracked files.
Later Git edits or commits do not change the running process's metadata.
The template's `.gitignore` already excludes `node_modules`.

## Acquisition data

The server stores acquisition data outside the checkout. Set
`AMBION_SENSOR_DATA_DIR` to an absolute path outside the checkout to choose
the directory. Otherwise it uses
`$XDG_STATE_HOME/ambion/sensor-server/<checkout-id>`, or
`~/.local/state/ambion/sensor-server/<checkout-id>`. The server rejects a
path inside the checkout, including one that reaches it through a symlink.

It writes `acquisition.json` once, appends each successful latest-read
request and result to `observations.jsonl`, and stores frame bytes at
`blobs/<sha256>`. The first acquisition fixture is write-once; later
observations append to the log. The current server code does not read the
observation log as history. Git commits contain code and fixtures, not this
data.

## Stop, replace, and roll back

Use the workspace `cancel({ handle })` call to stop the process before
editing or replacing the checkout, for example
`cancel({ handle: 'bash-1a2b3c4d5e6f' })`. The server handles SIGINT and
SIGTERM and closes its listener. Then validate, commit, push, and start the
saved version as a new process. Keep the same
`AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench"` value when replacing or
rolling back so each version uses the same persistent data directory. Save
the new handle and readiness port before connecting again.

Rollback means stopping the process, checking out an earlier commit, and
starting that code with the same data directory. The template's current
`acquisition.json`, append-only JSONL observations, and digest-named blobs
remain in place; Git rollback does not rewind them. The current server does
not read prior observation records, and no library data migration or
compatibility upgrade is provided. If a code change alters the format or
meaning of data that a server version reads, use a separate data directory
or make a backup before switching versions. A future format change must
document its own compatibility behavior.
