# CLI: create a project and test agents locally

Implementation, 2026-09-15. The template and `new`/`dev` commands are implemented.
The local manual development loop has passed acceptance testing.

**Build the smallest local development loop.** Create a project, edit its
agents, and talk to them together in a terminal room. Use Wrangler and the
Cloudflare runtime locally so the project can support deployment later.

## User experience

```sh
ambion new my-team
cd my-team
pnpm install
# Add a model provider key to .dev.vars.
pnpm exec ambion dev
```

`ambion new` creates a project with two editable agents in one room.
`ambion dev` starts the local Worker and opens the team's room in an
[OpenTUI](https://opentui.com/) terminal interface.
The developer sends messages, reads agent replies, and inspects errors.
After editing agent definitions, restart `ambion dev` to test the changes.

## Work sequence

### 1. Make a minimal project template

**Reuse the existing Cloudflare adapter and site example.**

- [x] Add two simple agents with different instructions and one configured model.
- [x] Define one room and one local human participant.
- [x] Include a Worker entry point with only the routes needed to start the
      room, join it, send messages, read messages, and look up exchanges.
- [x] Include `package.json`, `wrangler.jsonc`, `.gitignore`, a credential
      example, and short setup instructions.
- [x] Use a pinned Wrangler dependency and the existing room and seat
      Durable Objects. Keep the template free of application resource storage.
- [x] Make the CLI and adapter dependencies installable outside the monorepo.
- [ ] Publish matching versions of the CLI, runtime, journal, and adapter.

**Done when:** the template runs with `wrangler dev`. A developer can send
one message over HTTP and read both agents' contributions.

**Evidence:** The packed-consumer test invokes the packaged `ambion new`
command outside the repository. It verifies the generated template, registry
configuration, dependency versions, and overwrite protection. Local archives
are test fixtures only. There is no separate project-creation script.

Standalone installation, typechecking, CLI execution, and Wrangler bundling
passed. A live Anthropic test received contributions from both agents.
Invalid message input returned HTTP 400. Room history survived a restart.
Repository formatting and checks passed. Exchange lookup retains its identity
response; the new status endpoint provides working/completed state for the
terminal interface.

### 2. Implement `ambion new`

**Copy the working template into a new directory.**

- [x] Accept a project directory and refuse to overwrite existing files.
- [x] Set the project name and write the template files.
- [x] Print dependency installation and provider credential instructions.

**Done when:** a generated project outside the repository installs and starts
without workspace links. The generated `.npmrc` selects GitHub Packages and
references `GITHUB_TOKEN`. The normal path installs published dependencies.

### 3. Implement `ambion dev`

**Start Wrangler and open the team room with OpenTUI.**

- [x] Use `@opentui/core` for the CLI's terminal interface. Keep it outside
      the Worker bundle.
- [x] Pin OpenTUI and verify its runtime and native package requirements.
      Document the required runtime and launch flags in the setup instructions.
- [x] Launch the project's Wrangler on loopback and wait for the Worker
      to answer a readiness request.
- [x] Start or resume the configured room and join as the local participant.
- [x] Show the room name, team members, a scrollable conversation, and a
      message input. Support keyboard submission and terminal resizing.
- [x] Poll for new messages and exchange state. Show agent names, replies,
      whether the room is working, and errors.
- [x] Keep Worker logs readable without corrupting the input prompt.
- [x] Report missing credentials, an occupied port, and startup failures clearly.
- [x] On exit, stop polling, dispose the OpenTUI renderer, restore the terminal,
      and terminate the Wrangler child process.

Reuse the site example's interaction behavior with OpenTUI rendering.
Keep the HTTP client small and internal to the CLI. Polling is sufficient.
Live tool-event transport can wait.

The CLI pins OpenTUI 0.5.11. Install dependencies and run `dev` with Node.js
26.4+; the launcher supplies `--experimental-ffi`. Native OpenTUI was tested
on macOS with Node.js 26.8.2. Ambion core retains its Node.js 22.19 minimum.
See [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/).

**Done when:** the developer can ask several questions in one terminal session
and inspect the agents' discussion. Exiting leaves no development server running.

### 4. Verify the manual development loop

**Use the generated project for the acceptance check.**

- [x] Create a project, install dependencies, and configure a provider key.
- [x] Start the terminal room and ask a question that involves both agents.
- [x] Verify input, conversation scrolling, resizing, and terminal restoration
      in the OpenTUI interface.
- [x] Edit one agent's instructions, restart, and observe the changed behavior.
- [x] Confirm that local room history survives a restart through Wrangler storage.
- [x] Document the local state directory and how to reset it for a fresh test.
- [x] Check that invalid credentials produce a visible error and the CLI exits
      cleanly when interrupted.

**Complete when:** a developer can create, edit, and manually test agents
without working inside the Ambion repository.

**Acceptance evidence:** Luna/High verified packed installation outside the
repository, `ambion new`, overwrite refusal, and generated-project typechecking.
A real terminal session received live replies from both Anthropic agents and
showed activity. Restarting restored history; changing the planner instructions
produced the expected changed response. Conversation scrolling, terminal resize events, Ctrl-C, and external SIGTERM
cleanup passed with no Wrangler or workerd processes left running. Missing credentials
and occupied ports produced clear errors. A fresh packed terminal run displayed
`401 authentication_error: invalid x-api-key` in the full-width error area.
Temporary credentials were removed after live tests.

Run `node scripts/cli-team-smoke.mjs` for the packed-consumer check, or add
`--live` for an interactive session using `~/.anthropic/dev-key`. The script
removes its temporary credential file on exit. Stop the room and remove its
`.wrangler/` directory to reset local history.

## Later

**Keep this milestone to two commands and one local room.** Automated
evaluations, deployment commands, remote authentication, multiple terminal
clients, WebSockets, live tool activity, and production operations follow later.
The CLI and Cloudflare adapter ship together in a lockstep prerelease.
Registry publication and installation verification remain pending until the
release workflow succeeds. See [the delivery plan](next.md).

## Starting points

- [OpenTUI documentation](https://opentui.com/docs/)
- [CLI commands](../packages/cli/README.md)
- [Cloudflare adapter](../packages/cloudflare/README.md)
- [Terminal and Worker example](../examples/site/README.md)
- [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/)
