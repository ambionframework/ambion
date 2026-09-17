# Documentation

Ambion is a collaboration kernel for independently owned agents and the
people they serve. Agents own domain behavior. Rooms provide a shared journal,
participation rules, and optional summaries for completed human exchanges.

Start with the [repository README](../README.md) for installation and a small
room. The documents below describe contracts that are easy to miss when
reading the implementation. Detailed API shapes and invariants are linked from
each page.

## Contracts

| Document                    | Use it for                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| [Agent](agent.md)           | Definitions, tools, activation rules, and room operations        |
| [Exchange](exchange.md)     | Human questions, completion, and durable result handles          |
| [Presence](presence.md)     | Visits, arrivals, departures, and catch-up                       |
| [Roster](roster.md)         | Agent membership, reserve, and attention                         |
| [Summaries](summary.md)     | Optional closing work and context replacement                    |
| [Workspace](workspace.md)   | Shared filesystem resources and lifecycle                        |
| [Durability](durability.md) | Journal guarantees, recovery, leases, and failure evidence       |
| [Deployment](deployment.md) | Host placement, storage, reconnect, and operational limits       |
| [Evals](evals.md)           | Generic code evals and lifecycle, applied first to the assistant |
| [Toolchain](toolchain.md)   | Package layout, checks, CI, and release commands                 |

## Navigation hints

[Default assistant](assistant.md) describes the assistant package, room
configuration shorthand, and Relay integration.

`agent.md` is the entry point for the runtime model. Read `exchange.md` and
`presence.md` for the two durable concepts built on top of it. Read
`durability.md` before choosing storage or recovery behavior, then
`deployment.md` for host procedures. `toolchain.md` is the repository guide;
the [0.1.0 scope](../planning/release-0.1.0.md) and [delivery plan](../planning/next.md)
are planning records, not API references.

Human review and agent context intentionally differ: after a close, a summary
may stand for its covered messages in later activations, while
`exchange.waitForClose()` always returns the original discussion. The journal
retains both.
