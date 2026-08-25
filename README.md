# Ambion

A minimalist framework for ambient-aware, always-on agents. TypeScript. Deployed on Cloudflare at scale. Inspired by Pi.

[ambionframework.com](https://ambionframework.com)

## Why

Most agent frameworks model **invocation**: a request comes in, a workflow runs, a result comes out.

Ambion models **presence**. Agents don't run — they wait. They subscribe to the things they care about and wake when something happens. Policies over workflows.

## Core model

Five primitives. Nothing else.

**Workspace** — the unit of deployment. Multiple agents collaborate on a shared list of tasks.

**Agent** — an always-on participant in a workspace. Agents hold tools to manage tasks, timers, and their own subscriptions.

**Task** — a shared work item on the workspace list. Tasks can carry subscriptions.

**Subscription** — the only activation mechanism. Every subscription is a thread supporting bidirectional, multi-turn message exchange:

- Human ↔ agent steering and querying is a subscription.
- Agent ↔ agent interaction is a subscription — the same mechanism, no special case.
- Certain subscriptions support input filtering, so agents wake only on what matters.
- Agents create, modify, and drop subscriptions themselves.

**Timer** — standalone or attached to a task. A timer can carry a subscription, turning the passage of time into just another message on a thread.

## The invariant

There is exactly one way an agent activates: **a message arrives on a subscription.** Human input, peer messages, task events, timers — all reach an agent through the same door.

This single invariant is what makes the system small enough to reason about and durable enough to run unattended.

## Runtime

- **Edge-native.** Workspaces map onto Cloudflare Durable Objects; threads are durable state, not in-memory sessions.
- **Always on, rarely running.** Agents are dormant between activations. Cost scales with events, not wall-clock time.
- **Resumable by construction.** Because every interaction is a persisted thread, there is no session to lose.

## Install

Ambion publishes to **GitHub Packages** under the `@ambionframework` scope.
GitHub Packages requires authentication even to _read_ a package, so installing
takes one extra step compared with the public npm registry.

**1. Create a personal access token.** A [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with the `read:packages` scope is enough to install. (Fine-grained tokens do not
yet cover GitHub Packages for npm.) Keep it out of your shell history:

```sh
export GITHUB_TOKEN=ghp_yourtokenhere
```

**2. Point the scope at GitHub Packages.** In your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Referencing `${GITHUB_TOKEN}` rather than pasting the token means this file is
safe to commit. If you would rather keep it entirely local, put the same two
lines in `~/.npmrc` instead.

**3. Install.**

```sh
npm install @ambionframework/ambion
npm install --save-dev @ambionframework/cli
```

In GitHub Actions the built-in token already has read access — no PAT needed:

```yaml
- uses: actions/setup-node@v5
  with:
    node-version: 22
    registry-url: https://npm.pkg.github.com
    scope: '@ambionframework'
- run: npm ci
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Every release is packed once and signed with a [build provenance
attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations),
so you can verify a tarball came from this repository:

```sh
gh attestation verify ambionframework-ambion-0.1.0.tgz --repo ambionframework/ambion
```

> **A public repository does not remove this step.** GitHub Packages gates the
> npm registry separately from repository visibility: a package published from a
> public repo still answers anonymous requests with `401 Unauthorized`. (Compare
> `curl https://npm.pkg.github.com/@github%2frelative-time-element` — a public
> package from a public repo — with a package that simply does not exist, which
> returns a plain `404`.) So the token is required for every consumer, and
> moving the stable line to npmjs.com is tracked as future work.

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

> **Status: scaffold.** The five primitives above describe what Ambion is meant
> to be, not what these packages do yet. Both are placeholders: they build,
> type-check, pack and publish, which proves the release path before there is
> anything to release. The runtime lands in a follow-up.

| Path              | Package                                                      |
| ----------------- | ------------------------------------------------------------ |
| `packages/ambion` | [`@ambionframework/ambion`](packages/ambion) — the runtime   |
| `packages/cli`    | [`@ambionframework/cli`](packages/cli) — the `ambion` binary |

```sh
pnpm install
pnpm check                              # build, typecheck, lint, test
./packages/cli/bin/ambion.mjs --help
```

Packages publish to GitHub Packages under the `@ambionframework` scope.
[`docs/toolchain.md`](docs/toolchain.md) specifies the build, CI, and release
setup; [`CONTRIBUTING.md`](CONTRIBUTING.md) is the short version.

## Design principles

1. One activation mechanism.
2. Everything is a thread.
3. Agents manage their own attention (subscriptions and timers are agent-controlled).
4. Minimal surface: five primitives, one invariant.

## License

[Apache 2.0](LICENSE)
