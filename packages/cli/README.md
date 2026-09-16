# @ambionframework/cli

**Create a team project and test its agents locally.** `ambion new` writes
an editable project. `ambion dev` runs its Worker through Wrangler and opens
an OpenTUI room with the team, conversation, message input, and Worker logs.

## Requirements

Use Node **26.4 or newer** and pnpm 10 to install the CLI and run `dev`.
OpenTUI needs Node's experimental FFI. The `ambion` launcher adds the required
flag for `dev`. The room and its agents run separately in local workerd.

## Start from this checkout

**Use local archives while the Cloudflare adapter remains private.** The
helper builds the packages, copies the team template, and configures local
dependencies. Choose a new directory outside the repository. Its parent must
already exist.

```sh
# Run from the Ambion repository root.
pnpm install --frozen-lockfile
node scripts/prepare-team.mjs ../my-team
cd ../my-team
pnpm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set ANTHROPIC_API_KEY.
pnpm exec ambion dev
```

The project contains the `planner` and `reviewer` agents and the `human`
participant. Ask the team a question, such as “Plan a small documentation site
and review the risks.” Both agents can contribute to the conversation.

The helper uses the same template as `ambion new`. It also supplies local
package archives and dependency overrides. Registry publication remains a
separate release decision.

## Create a project with `ambion new`

With an installed CLI, run:

```sh
pnpm exec ambion new ../another-team
```

The command copies the template and prints the setup steps. The project name
uses 1–63 lowercase letters, numbers, or dashes. It cannot start or end with a
dash. `new` refuses to overwrite a directory that contains files. It sets the
package and Worker names from the directory name.

**The generated manifest uses package versions from the registry.** Until
publication, those dependencies need local archives before `pnpm install`.
Use the checkout helper above for a project that you can install immediately.

## Configure the model

Set `ANTHROPIC_API_KEY` in the project's `.dev.vars`. The default model is
`anthropic/claude-sonnet-5`. Set `AMBION_MODEL` to another supported
`provider/model-id` and supply that provider's key in the same file.

The CLI reads local credentials from `.dev.vars`. It does not load
`~/.anthropic` automatically. The generated `.gitignore` excludes `.dev.vars`
and local Wrangler state.

## Test the team

```sh
pnpm exec ambion dev                 # current project, port 8787
pnpm exec ambion dev --port 8788      # use another local port
pnpm exec ambion dev ../another-team # open another team project
```

Enter a message to ask the team a question. The interface shows each agent's
contribution and whether the room is working. Scroll the conversation with the
mouse wheel. Worker errors appear below the conversation and in the logs.
Ctrl-C closes the interface and stops its development server.

Edit the agents in `src/room.ts`, then restart `dev` to test the changes.
The room resumes from its local `.wrangler/` storage. Stop `dev` and remove
that directory to start with an empty room.

For HTTP-only testing, run `pnpm dev:worker`. Follow the generated README
for the `/start`, `/join`, `/send`, `/messages`, and `/status` routes.

## Verify the CLI from the repository

Run `node scripts/cli-team-smoke.mjs` from the repository root. It checks the
packed CLI and a generated project outside the repository.

Add `--live` to open an interactive room using `~/.anthropic/dev-key`.
This test makes live model requests. It removes the temporary credential file
on exit, including when `--keep` retains the test project.

The first version serves one local human and one room on loopback. It has no
deployment command. See [the CLI plan](../../planning/cli.md) for scope and
acceptance evidence, and [deployment and recovery](../../docs/deployment.md)
for the host contracts.

Apache 2.0.
