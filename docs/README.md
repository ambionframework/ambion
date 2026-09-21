# Documentation

Ambion is a collaboration kernel for agents and humans. A room is a shared
journal with rules for taking part. The kernel keeps the record and the
rules.

Start with the [repository README](../README.md) for installation and a small
room. The documents below describe contracts that are easy to miss when
reading the implementation. Detailed API shapes and invariants are linked from
each page.

## Contracts

| Document                          | Use it for                                                    |
| --------------------------------- | ------------------------------------------------------------- |
| [Room](room.md)                   | Overview, glossary, and the room-wide mechanisms              |
| [Definitions and tools](agent.md) | Definitions, tools, and the execution boundary                |
| [Assistant](assistant.md)         | The default assistant package and the `assistant` room option |
| [Exchange](exchange.md)           | Human questions, completion, and durable result handles       |
| [Presence](presence.md)           | Visits, arrivals, departures, and catch-up                    |
| [Roster](roster.md)               | Agent membership, reserve, and attention                      |
| [Summaries](summary.md)           | Optional closing work and context replacement                 |
| [Resources](resources.md)         | The resource contract, references, and provenance             |
| [Workspace](workspace.md)         | The Pi filesystem binding of the resource contract            |
| [Example](example.md)             | The one runnable example: an agentic lab workspace            |
| [Durability](durability.md)       | Journal guarantees, recovery, leases, and failure evidence    |
| [Formal](formal.md)               | The verified rules, their proofs, and how the gate runs them  |
| [Deployment](deployment.md)       | Host placement, storage, reconnect, and operational limits    |
| [Envelope](envelope.md)           | Configurable limits and the measured cost of the fold         |
| [Toolchain](toolchain.md)         | Package layout, checks, CI, and release commands              |

## Navigation hints

Read `resources.md` for the resource contract and `workspace.md` for the
filesystem binding.

`assistant.md` describes the assistant package, the room configuration
shorthand, and how the workbench example evaluates it.

`room.md` is the entry point for the runtime model. Read `agent.md` for
definitions, tools, and the execution boundary. Read `exchange.md` and
`presence.md` for the two durable concepts built on the room. Read
`durability.md` before choosing storage or recovery behavior, then
`deployment.md` for host procedures. `envelope.md` lists every
configurable limit and the cost of the fold. `formal.md` states how a rule is
proven and how a change to one reaches the gate. `toolchain.md` is the repository guide;
[the plan](../planning/next.md) and [the backlog](../planning/backlog.md)
are planning records, not API references.

Human review and agent context intentionally differ: after a close, a summary
may stand for its covered messages in later activations, while
`exchange.waitForClose()` always returns the original discussion. The journal
retains both.
