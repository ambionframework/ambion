# @ambionframework/cli

**Create a team project and test its agents locally.** `ambion new` creates
an editable project. `ambion dev` runs its Worker through Wrangler and opens
an OpenTUI room with the team, conversation, message input, and Worker logs.

## Requirements

Use Node **26.4 or newer**, pnpm 10, and an interactive terminal.
The launcher enables the experimental FFI that OpenTUI requires.
The room and its agents run separately in local workerd.

## Install the CLI

The packages use GitHub Packages. Set `GITHUB_TOKEN` to a classic personal
access token with `read:packages`. Add these lines to your user `~/.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Install the prerelease from the `next` tag:

```sh
npm install --global @ambionframework/cli@next
```

## Create and start a team

**Use `ambion new` for every project.** It creates the template, sets the
project name, and selects matching Ambion dependency versions.

```sh
ambion new my-team
cd my-team
pnpm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set ANTHROPIC_API_KEY.
ambion dev
```

The generated `.npmrc` configures GitHub Packages. It references
`GITHUB_TOKEN` without storing a token. Keep that variable available when you
install dependencies. No local package archives are needed.

The team contains the `planner` and `reviewer` agents and the `human`
participant. Ask a question, such as “Plan a small documentation site and
review the risks.” Both agents can contribute.

The project name uses 1–63 lowercase letters, numbers, or dashes. It cannot
start or end with a dash. `new` refuses to overwrite existing files.

## Configure the model

Set `ANTHROPIC_API_KEY` in the project's `.dev.vars`. The default model is
`anthropic/claude-sonnet-5`. Set `AMBION_MODEL` to another supported
`provider/model-id` and supply that provider's key in the same file.

The CLI reads credentials from `.dev.vars`. It does not load `~/.anthropic`
automatically. The generated `.gitignore` excludes `.dev.vars` and local
Wrangler state.

## Test the team

```sh
ambion dev                 # current project, port 8787
ambion dev --port 8788     # use another local port
ambion dev ../another-team # open another team project
```

Enter sends a message. Scroll the conversation with the mouse wheel.
Worker errors appear below the conversation and in the logs. Ctrl-C closes
the interface and stops its development server.

Edit agent instructions in `src/room.ts`, then restart `dev`.
History remains in `.wrangler/`. Stop `dev` and remove that directory to
start with an empty room.

For HTTP-only testing, run `pnpm dev:worker`. The generated README documents
the `/start`, `/join`, `/send`, `/messages`, and `/status` routes.

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
Deployment commands remain future work. See [the CLI plan](../../planning/cli.md)
and [deployment and recovery](../../docs/deployment.md) for scope.

Apache 2.0.
