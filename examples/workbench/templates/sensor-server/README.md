# Sensor server

This template serves deterministic numeric, frame, and text fixtures. It
needs Node 22.19 or newer, Git, and npm. It needs no hardware, model
provider, framework daemon, or ffmpeg. The wire contract is protocol
version 2. `api.mjs` holds its schemas, and the template owns them.

**The server is a process that serves HTTP on `$PORT`.** The workspace sets
`PORT` for every process that `bash` starts. Any agent reads the server with
`fetch({ process, path })`. The `observe` macro of the `sensor-server` skill
in `skills/` wraps the reads of one sensor.

| Path                                | Result                                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| `GET /`                             | `api: 2`, the source metadata, and the sensors with `spans`     |
| `GET /<sensor>/observe[?from=&to=]` | The latest observation, or the observations of a half-open span |
| `GET /files/<sha256>`               | Immutable bytes                                                 |

## Fork and install

Fork `templates/sensor-server` and clone it into your home with the
workspace Git tool. Start a branch before editing:

```ts
fork({ source: 'templates/sensor-server', name: 'bench-sensors', clone: '~/sensor-server' });
bash({ command: 'cd ~/sensor-server && git switch -c sensing' });
```

Install the one dependency, `typebox`, in the clone:

```sh
cd ~/sensor-server
npm install
```

Set `AMBION_SENSOR_REPOSITORY` to the fork's lowercase `namespace/name`
if the `origin` remote cannot provide it. Otherwise the server reads the
repository identifier from `origin`.

## Customize and validate

Edit `server.mjs` to change the fixture observations. Numeric values use a
series part, frame bytes live in `fixtures/frame.png`, and text uses a text
part. Keep timestamps in UTC with three millisecond digits. The server
checks every response against the schemas of `api.mjs`. The fixtures are
deterministic. A span request returns `422`, because all three index
entries declare `spans: false`. A malformed query returns `400`.

Run the template tests after making a change:

```sh
npm test
```

The tests run the real HTTP server. They check the schemas, the retained
file digests, the conformance cases of protocol version 2, bad requests,
launch metadata, and the external data directory.

After the tests pass, commit and push the branch before starting the saved
version:

```sh
git add server.mjs fixtures
git commit -m 'Customize sensor fixtures'
git push -u origin HEAD
```

## Start in a workspace

Start the server as a foreground workspace process. Give it a `name`. The
workspace `bash` tool runs it in the background and returns a process
handle:

```ts
bash({
  command:
    'cd ~/sensor-server && AMBION_SENSOR_REPOSITORY=instruments/bench-sensors ' +
    'AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/bench" node server.mjs',
  name: 'bench-sensors',
  wait: 1,
  timeout: 86400,
});
```

The server listens on `PORT`, which the workspace sets, and binds to
`127.0.0.1`. It exits when `PORT` is not set. It prints nothing when it
listens. Read it with `fetch`, or run the macro:

```ts
compose({
  macro: 'sensor-server/observe',
  args: { process: 'bench-sensors', sensor: 'operator-notes' },
});
```

The macro reads `GET /`, refuses a server that does not serve API 2, reads
the observation, and reads each file that the observation names. It checks
the SHA-256 of each file against its digest. It returns the refs to cite,
the measurement times, and the paths of the exported files. Add `from` and
`to`, two UTC timestamps, to read a span. A host loads the macro with
`loadSkills(fromDirectory('templates/sensor-server/skills'))`. The macro
that runs comes from the host's copy of the template. An edit of
`skills/` in a fork changes nothing that runs.

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
result to `observations.jsonl`, and stores frame bytes at
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
rolling back so each version uses the same persistent data directory. Name the
new process the same, so the macro reads it.

Rollback means stopping the process, checking out an earlier commit, and
starting that code with the same data directory. The template's current
`acquisition.json`, append-only JSONL observations, and digest-named blobs
remain in place; Git rollback does not rewind them. The current server does
not read prior observation records, and no library data migration or
compatibility upgrade is provided. If a code change alters the format or
meaning of data that a server version reads, use a separate data directory
or make a backup before switching versions. A future format change must
document its own compatibility behavior.
