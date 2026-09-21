# @ambionframework/cli

**Create a team project and test its agents locally.** `ambion new` creates
an editable project. `ambion dev` runs its room and opens
an OpenTUI room with a compact team header, a full-width conversation, and
message input.

## Requirements

Use Node **26.4 or newer**, pnpm 10, and an interactive terminal. The
`ambion dev` client also runs on Bun **1.3 or newer**. The launcher enables
the experimental FFI that OpenTUI requires.

## Install the CLI

The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).
Install the CLI:

```sh
npm install --global @ambionframework/cli
```

## Create and start a team

**Use `ambion new` for every project.** It creates the template, sets the
project name, and selects matching Ambion dependency versions. Two templates
exist:

- `--template node` is the default. The room and its agents run in the
  Node process of `ambion dev`. Its key file is `.env`.
- `--template cloudflare` runs the room and its agents as Durable Objects in
  local workerd. Its key file is `.dev.vars`.

```sh
ambion new my-team                        # node template
ambion new my-team --template cloudflare  # Cloudflare template
cd my-team
pnpm install
cp .env.example .env   # cloudflare: cp .dev.vars.example .dev.vars
# Edit the key file and set ANTHROPIC_API_KEY.
ambion dev
```

The generated project has no `.npmrc`. It installs from npmjs and needs no
token. No local package archives are needed.

To try a dev build from `main`, see the dev channel in
[the toolchain](../../docs/toolchain.md).

The team contains the `planner` and `reviewer` agents and the `human`
participant. Both agents can contribute to each question. The planner is also
the optional summary writer, so it may write the short closing message the
human reads.

The project name uses 1–63 lowercase letters, numbers, or dashes. It cannot
start or end with a dash. `new` refuses to overwrite existing files.

## Configure the model

Set `ANTHROPIC_API_KEY` in the project's key file (`.env` or `.dev.vars`).
The default model is `anthropic/claude-sonnet-5`. Set `AMBION_MODEL` to another supported
`provider/model-id` and supply that provider's key in the same file.

The CLI reads credentials from the key file. It does not load `~/.anthropic`
automatically. The generated `.gitignore` excludes the key file and local
state.

## Test the team

```sh
ambion dev                 # current project, port 8787
ambion dev --port 8788     # use another local port
ambion dev ../another-team # open another team project
```

Enter sends a message. Scroll the conversation with the mouse wheel.
One status line shows when the team is working. Errors appear below the
conversation. Ctrl-C closes the interface and stops its development server.

Edit agent instructions in `src/room.ts`, then restart `dev`. The generated
README names where history lives and how to start with an empty room.

## Work from a repository checkout

Build the CLI, then invoke its launcher. Project creation still uses `new`.
The generated project installs the corresponding published package versions.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/ambion.mjs new ../my-team
```

Run `node scripts/cli-team-smoke.mjs` to check an unpublished build. This test
packs local dependencies and exercises the actual `ambion new` command. Its
package fixtures are internal to the test.

The first version supports one local human and one room on loopback.
Deployment commands remain future work. See [the delivery plan](../../planning/next.md)
and [deployment and recovery](../../docs/deployment.md) for scope.

Apache 2.0.
