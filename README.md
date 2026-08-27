# Ambion

A minimalist framework for ambient-aware, always-on agents [ambionframework.com](https://ambionframework.com)

## Why

Most agent frameworks model **invocation**: a request comes in, a workflow runs, a result comes out.

Ambion models **presence**. Agents don't run — they wait. They subscribe to the things they care about and wake when something happens. Policies over workflows.

## Core model

Four primitives today, more to come.

**Agent** — `defineAgent` makes an agent: a name, an identity the room reads, instructions, a model, and tools. A value, not a process. [`docs/agent.md`](docs/agent.md) specifies it: a vanilla [Pi](https://pi.dev/docs/latest/sdk) agent that speaks only when spoken to — and not always then.

**Human** — `defineHuman` seats a person as a typed participant: named, carrying an identity agents read and address, on the record like anyone else. A session can seat several.

**Tool** — `defineTool`, a facade over Pi's own: same shape, one import. What an agent can do beyond speaking is exactly what its author gave it.

**Session** — `openSession` opens a named room: open a name again and you are back in it, record intact. A delivery activates the idle agents in parallel; replies steer colleagues still at work; each agent decides whether to speak, to whom, and which colleague — passive experts included — to call in. Silence leaves no mark, and provenance is stamped by the runtime, never self-reported.

## The invariant

There is exactly one way an agent activates: **a message is delivered into a session it belongs to** — by a human, a host, or a colleague's directed reply. And even then, it may decline.

The larger design — workspaces, sources and channels with their contracts, timers, batching, a virtual shell with a durable filesystem, tasks, the tenant — arrives one document at a time, each on top of this core: [`docs/concepts.md`](docs/concepts.md) fixes what, [`docs/roadmap.md`](docs/roadmap.md) fixes when.

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
4. Minimal surface: four primitives, one invariant, one dependency that does the rest.

## License

[Apache 2.0](LICENSE)
