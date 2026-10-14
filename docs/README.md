# Documentation

The [repository README](../README.md) shows how to install Ambion and run a
small room. Each page below describes the implemented API of one concern.
[The road to 1.0.0](../planning/1.0.0.md) and [the backlog](../planning/backlog.md)
are planning records and not API references.

## Understand the room

Read these pages in order. Each one builds on the page before it.

| Page                              | Use it for                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| [Room](room.md)                   | The model, the glossary, the room-wide mechanisms, and the collaboration patterns |
| [Definitions and tools](agent.md) | Agent and person definitions, and the tools of the room                           |
| [Exchange](exchange.md)           | Human questions, completion, and durable result handles                           |
| [Presence](presence.md)           | Visits, arrivals, departures, and catch-up                                        |
| [Roster](roster.md)               | Agent seating, reserve, and attention                                             |
| [Summaries](summary.md)           | Optional closing work and context replacement                                     |
| [Assistant](assistant.md)         | The default assistant package and the `assistant` room option                     |

## Build an agent

| Page                                  | Use it for                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| [Executors](executors.md)             | The executor contract, steps, the trace, and how to write an adapter                    |
| [Pi](pi.md)                           | The Pi package: options, exchange continuity, testing                                   |
| [Claude](claude.md)                   | The Claude Agent SDK package: policy, trust, sessions, testing                          |
| [Codex](codex.md)                     | The Codex package: install, options, trust, and testing                                 |
| [Resources](resources.md)             | The resource contract, tool bundles, references, and provenance                         |
| [Workspace](workspace.md)             | The workspace interface, its backends, and its tools                                    |
| [Snapshots](snapshots.md)             | `snapshot`, `restore`, and the object backend                                           |
| [SQL](sql.md)                         | The `sql` tool and the SQLite backend                                                   |
| [Processes](processes.md)             | Background processes: `bash`, `ps`, handles, the host's view, and reminders             |
| [Skills and macros](skills.md)        | Instructions that an agent reads from the workspace, and the macros that a skill stores |
| [Compose](compose.md)                 | The `compose` tool: join tools in one call through short code                           |
| [Git](git.md)                         | A git backend: read-only templates, forks, clones, and pushes                           |
| [Workstation](workstation.md)         | A remote server as a workspace over SSH, one account for each agent                     |
| [Workstation git](workstation-git.md) | The git backend on the workstation: one account, git over SSH, agent keys               |
| [Config repos](gitforeverything.md)   | A design: a private config repository for each agent, merged at startup                 |

## Show work to people

| Page                  | Use it for                                                        |
| --------------------- | ----------------------------------------------------------------- |
| [Canvas](canvas.md)   | The collection of rooms, and breakout rooms for background work   |
| [Widgets](widgets.md) | Live views that agents show on the canvas, and the design of acts |
| [Example](example.md) | The runnable example: an agentic lab workspace                    |

## Run a room

| Page                        | Use it for                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Durability](durability.md) | Journal guarantees, recovery, leases, cancellation, and the format                                                           |
| [Deployment](deployment.md) | Host placement, storage, reconnect, and operational limits                                                                   |
| [Limits](limits.md)         | Configurable limits and the cost of the fold                                                                                 |
| [Trust](trust.md)           | What one owner guarantees another, and what the kernel does not defend. Read it before you expose a room to untrusted agents |
| [Simulator](simulator.md)   | Evals where an agent plays a person, with checks and a judge                                                                 |

## Change Ambion

| Page                      | Use it for                                                   |
| ------------------------- | ------------------------------------------------------------ |
| [Toolchain](toolchain.md) | Package layout, checks, CI, and release commands             |
| [Formal](formal.md)       | The verified rules, their proofs, and how the gate runs them |

Human review and agent context differ on purpose. After a close, a summary
may stand for its covered messages in later activations, while
`exchange.waitForClose()` returns the original discussion. The journal keeps
both.
