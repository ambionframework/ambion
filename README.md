# Ambion

A minimalist framework for ambient-aware, always-on agents.

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

## CLI

```sh
npm create ambion@latest     # scaffold a workspace project
ambion dev                   # run the workspace locally
ambion deploy                # ship to Cloudflare
```

Define agents in TypeScript, declare their tools, deploy. The framework owns activation, threading, and durability.

## Design principles

1. One activation mechanism.
2. Everything is a thread.
3. Agents manage their own attention (subscriptions and timers are agent-controlled).
4. Minimal surface: five primitives, one invariant.

## License

[Apache 2.0](LICENSE)
