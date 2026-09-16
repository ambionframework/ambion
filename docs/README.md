# Documentation

**Ambion is a collaboration kernel for independently owned agents and the
people they serve.** Agents own their domain behavior. Rooms give them a
shared journal and rules for participation. An optional summary records the
result of a closed human exchange for its owner.

Start with the [repository README](../README.md) for the conceptual model,
installation, and a small room. These contracts explain the current code.
The [0.1.0 scope](../planning/release-0.1.0.md) defines the release target;
[the delivery plan](../planning/next.md) tracks implementation and evidence.

## Contracts

| Document                    | Read it for                                                     |
| --------------------------- | --------------------------------------------------------------- |
| [Agent](agent.md)           | Definitions, tools, room operations, and contribution rules     |
| [Exchange](exchange.md)     | Discussion boundaries, completion, and durable result handles   |
| [Presence](presence.md)     | Human visits and recorded arrivals and departures               |
| [Roster](roster.md)         | Agent definitions, membership, attention, and reserve           |
| [Summaries](summary.md)     | Optional closing assignments and summary context                |
| [Workspace](workspace.md)   | Optional filesystem resources and their lifecycle               |
| [Durability](durability.md) | Journal guarantees, recovery, leases, and failure tests         |
| [Deployment](deployment.md) | Host placement, storage, operational duties, and support levels |
| [Toolchain](toolchain.md)   | Builds, checks, package layout, and publishing                  |

**Human review and activation context have different views.** Once a closed
exchange has a summary, later activations read it in place of covered source
messages. Human participants can review those messages through
`exchange.messages()`. The journal retains the complete discussion.

## Current code and the release target

**The release plan includes changes that are not implemented yet.** Use the
current examples with this checkout. Do not treat proposed package names in
the plan as available exports.

| Area       | Current code                                                            | 0.1.0 target                                                               |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Membership | Fixed `agents` definitions, optional `seats`, and name-based operations | Ordinary agents can seat and unseat supplied colleagues                    |
| Pi audits  | `@ambionframework/pi-journal`                                           | Preserve full Pi sessions independently of the collaboration runtime       |
| Summaries  | Optional closing assignment through regular `say`                       | Preserve fixed context and room-stamped provenance                         |
| History    | Version 2 composition entries                                           | Reject legacy assistant histories explicitly                               |
| CLI        | Project creation and local OpenTUI rooms                                | CLI and adapter share a prerelease; see [the CLI plan](../planning/cli.md) |

These differences are tracked in the delivery plan. Dated [demo reports](../demos)
remain historical evidence for the versions they ran.
