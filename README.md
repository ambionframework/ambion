# Ambion

A minimalist framework for ambient-aware, always-on agents [ambionframework.com](https://ambionframework.com)

## Why

Most agent frameworks model **invocation**: a request comes in, a workflow runs, a result comes out.

Ambion models **presence**. Agents don't run — they wait. They subscribe to the things they care about and wake when something happens. Policies over workflows.

Most agent products model **the monolith**: one large agent, given more context
as it asks for it. Progressive disclosure holds it together. Every domain you
add makes the prompt longer and every other domain harder to reason about, and
no one owns the result.

Ambion models **the team**. Many agents, each one expert in a single domain and
accountable for it. They draw on capabilities the platform provides — the
session, the record, tools — instead of each one carrying a private copy. They
work in a workspace built for collaboration, where an agent reads what a
colleague did and calls that colleague in by name. The complexity lives in the
composition, not in one prompt.

The session is that workspace today. Workspaces, channels, and the shared
filesystem are designed and not built.

## Core model

Four things to define, and a session to put them in.

**Agent** — `defineAgent` makes an agent: a name, an identity the room reads, instructions, a model, and tools. A value, not a process. [`docs/agent.md`](docs/agent.md) specifies it: a vanilla [Pi](https://pi.dev/docs/latest/sdk) agent that speaks only when spoken to — and not always then.

**Human** — `defineHuman` names a person: an identity agents read and address, on the record like anyone else. People are not part of a room's composition — they visit a running session and leave it, several at once and from several devices, and the room tracks who is reading. Arriving is a message, so the agents wake for it. [`docs/presence.md`](docs/presence.md) specifies it.

**Aide** — a person may bring one, as an optional field on `defineHuman` rather than a fifth thing to define: a `defineAgent` value that holds their brief and their preferences, and writes the one message they read when the room goes quiet. It is a seat like any other, seated where nothing said reaches it and woken by the close of its person's exchange. It never speaks for them, never wakes anybody, and carries no tools of its own — the one hand it holds is the runtime's, and it reaches the record. From the next activation the agents read its summary in place of the messages it stands for, so an exchange that is over costs the room one message instead of growing every context for ever. [`docs/aide.md`](docs/aide.md) specifies it.

**Tool** — `defineTool`, a facade over Pi's own: same shape, one import. What an agent can do beyond speaking is exactly what its author gave it.

**Attention** — what wakes a seat, chosen when the agent is seated rather than when it is defined: one widening scale from `none` (nothing said reaches it) through `named` (only a message addressed to it) and `broadcast` (anything said, the default) to `presence` (also somebody arriving or leaving). `seated(agent, attention)` picks a point, with `passive(agent)` and `attentive(agent)` as shorthand for the two worth naming; a bare agent takes the default. Every message has a reach, and a seat wakes when its attention is at least that wide — which is the whole routing rule, and the reason an aide is an ordinary seat rather than a special case.

**Session** — a named room that outlives any run of it. `startSession` brings one up from its agents and a goal that says what the room is for; `stopSession` takes it down; `readSession` reads the record between runs, with nothing standing up and nothing to bill. A delivery activates the idle agents in parallel; replies steer colleagues still at work; each agent decides whether to speak, to whom, and which colleague — the quiet expert in the corner included — to call in. Silence leaves no mark, and provenance is stamped by the runtime, never self-reported.

## The invariant

There is exactly one way an agent activates: **a message is delivered into a session it belongs to** — by a person speaking, a person arriving or leaving, or a colleague's directed reply. And even then, it may decline.

The larger design — workspaces, channels with read/write contracts, timers, batching, a virtual shell with a durable filesystem, tasks, the tenant — arrives one document at a time, each on top of this core.

## Runtime

- **Always on, rarely running.** Agents are dormant between activations. Cost scales with events, not wall-clock time.
- **Node first.** The core runs in-process, tested in vitest; the edge deployment (Cloudflare Durable Objects) is a designed destination, tackled later.
- **Storage-ready.** Sessions run in memory today behind a storage interface, so durability is a later implementation, not an API change.

## Install

Ambion publishes to GitHub Packages, which requires a token even to read — a
public repository does not change that.

Create a [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with `read:packages`, then in your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The token is read from the environment, so the file is safe to commit.

```sh
export GITHUB_TOKEN=…
npm install @ambionframework/ambion
```

In GitHub Actions the built-in `GITHUB_TOKEN` already carries the scope.
[`docs/toolchain.md`](docs/toolchain.md) covers that, and verifying a release's
provenance attestation.

## CLI

```sh
npm create ambion@latest     # scaffold a workspace project
ambion dev                   # run the workspace locally
ambion deploy                # ship to Cloudflare
```

Define agents in TypeScript, declare their tools, deploy. The framework owns activation, threading, and durability.

None of these commands exist yet. The published `ambion` binary currently
reports its version and nothing else; the commands arrive with the runtime.

## Repository

| Path              | Package                                                      |
| ----------------- | ------------------------------------------------------------ |
| `packages/ambion` | [`@ambionframework/ambion`](packages/ambion) — the runtime   |
| `packages/cli`    | [`@ambionframework/cli`](packages/cli) — the `ambion` binary |

```sh
pnpm install
pnpm check
```

[`docs/toolchain.md`](docs/toolchain.md) specifies the build, CI and release
setup. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the short version.

## Design principles

1. One activation mechanism.
2. Everything is a message on a record.
3. Agents manage their own attention — deciding not to engage included.
4. Many domain agents, not one monolith. The platform shares the capabilities.
5. What a person wants belongs to that person, not to every agent that answers them.
6. Minimal surface: four things to define, one invariant, one dependency that does the rest.

## License

[Apache 2.0](LICENSE)
