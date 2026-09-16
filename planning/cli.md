# CLI: create a project and test agents locally

Proposal, 2026-09-15. Commands below are proposed work.

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

- [ ] Add two simple agents with different instructions and one configured model.
- [ ] Define one room and one local human participant.
- [ ] Include a Worker entry point with only the routes needed to start the
      room, join it, send messages, and read messages and exchange state.
- [ ] Include `package.json`, `wrangler.jsonc`, `.gitignore`, a credential
      example, and short setup instructions.
- [ ] Use a pinned Wrangler dependency and the existing room and seat
      Durable Objects. Keep the template free of application resource storage.
- [ ] Make the CLI and adapter dependencies installable outside the monorepo.
      Local package archives are sufficient for the initial development check.

**Done when:** the template runs with `wrangler dev`. A developer can send
one message over HTTP and read both agents' contributions.

### 2. Implement `ambion new`

**Copy the working template into a new directory.**

- [ ] Accept a project directory and refuse to overwrite existing files.
- [ ] Set the project name and write the template files.
- [ ] Print dependency installation and provider credential instructions.

**Done when:** a generated project outside the repository installs and starts
without workspace links or manual source changes.

### 3. Implement `ambion dev`

**Start Wrangler and open the team room with OpenTUI.**

- [ ] Use `@opentui/core` for the CLI's terminal interface. Keep it outside
      the Worker bundle.
- [ ] Pin OpenTUI and verify its runtime and native package requirements.
      Document the required runtime and launch flags in the setup instructions.
- [ ] Launch the project's Wrangler on loopback and wait for the Worker
      to answer a readiness request.
- [ ] Start or resume the configured room and join as the local participant.
- [ ] Show the room name, team members, a scrollable conversation, and a
      message input. Support keyboard submission and terminal resizing.
- [ ] Poll for new messages and exchange state. Show agent names, replies,
      whether the room is working, and errors.
- [ ] Keep Worker logs readable without corrupting the input prompt.
- [ ] Report missing credentials, an occupied port, and startup failures clearly.
- [ ] On exit, stop polling, dispose the OpenTUI renderer, restore the terminal,
      and terminate the Wrangler child process.

Reuse the site example's interaction behavior with OpenTUI rendering.
Keep the HTTP client small and internal to the CLI. Polling is sufficient.
Live tool-event transport can wait.

OpenTUI currently documents Bun 1.3+ or Node.js 26.4+ with
`--experimental-ffi`. Resolve this CLI requirement during implementation;
Ambion's existing Node.js minimum alone does not satisfy it.
See [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/).

**Done when:** the developer can ask several questions in one terminal session
and inspect the agents' discussion. Exiting leaves no development server running.

### 4. Verify the manual development loop

**Use the generated project for the acceptance check.**

- [ ] Create a project, install dependencies, and configure a provider key.
- [ ] Start the terminal room and ask a question that involves both agents.
- [ ] Verify input, conversation scrolling, resizing, and terminal restoration
      in the OpenTUI interface.
- [ ] Edit one agent's instructions, restart, and observe the changed behavior.
- [ ] Confirm that local room history survives a restart through Wrangler storage.
- [ ] Document the local state directory and how to reset it for a fresh test.
- [ ] Check that invalid credentials produce a visible error and the CLI exits
      cleanly when interrupted.

**Complete when:** a developer can create, edit, and manually test agents
without working inside the Ambion repository.

## Later

**Keep this milestone to two commands and one local room.** Automated
evaluations, deployment commands, remote authentication, multiple terminal
clients, WebSockets, live tool activity, and production operations follow later.
Publication is a separate release decision under [the delivery plan](next.md).

## Starting points

- [OpenTUI documentation](https://opentui.com/docs/)
- [CLI scaffold](../packages/cli/README.md)
- [Cloudflare adapter](../packages/cloudflare/README.md)
- [Terminal and Worker example](../examples/site/README.md)
- [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/)
