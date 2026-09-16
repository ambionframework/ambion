# @ambionframework/cli

**Create a team project and test its agents locally.** `ambion new` writes
an editable project. `ambion dev` runs its Worker through Wrangler and opens
an OpenTUI room with the team, conversation, message input, and Worker logs.

## Requirements

Use Node **26.4 or newer** and pnpm 10 to install the CLI and run `dev`.
OpenTUI needs Node's experimental FFI. The `ambion` launcher adds the required
flag for `dev`. The room and its agents run separately in local workerd.

## Create a project

```sh
ambion new my-team
cd my-team
pnpm install
cp .dev.vars.example .dev.vars
# Set ANTHROPIC_API_KEY in .dev.vars.
pnpm exec ambion dev
```

The project name uses lowercase letters, numbers, and dashes. `new` refuses
to overwrite a directory that contains files. It sets the package and Worker
names from the directory name.

**Local archives are required while the Cloudflare adapter remains private.**
For development from this repository, prepare a standalone project with the
helper below. It builds and packs the local packages without publishing them.

```sh
node scripts/prepare-team.mjs /absolute/path/to/my-team
```

Install dependencies in that directory, configure `.dev.vars`, and run
`pnpm exec ambion dev`. The helper supplies the local package dependencies.
Registry publication remains a separate release decision.

Run `node scripts/cli-team-smoke.mjs` from the repository to verify the packed
CLI and a generated project. Add `--live` to open an interactive room using
`~/.anthropic/dev-key`; the script removes its temporary credential file on exit.

## Test the team

```sh
ambion dev                     # current project, port 8787
ambion dev ./my-team --port 8788
```

Enter a message to ask the team a question. The interface shows each agent's
contribution and whether the room is working. Scroll the conversation with the
mouse wheel. Worker errors appear below the conversation and in the logs.
Ctrl-C closes the interface and stops its development server.

Edit the agents in `src/room.ts`, then restart `dev` to test the changes.
The room resumes from its local `.wrangler/` storage. Stop `dev` and remove
that directory to start with an empty room.

The first version serves one local human and one room on loopback. It has no
deployment command. See [the CLI plan](../../planning/cli.md) for scope and
acceptance evidence, and [deployment and recovery](../../docs/deployment.md)
for the host contracts.

Apache 2.0.
