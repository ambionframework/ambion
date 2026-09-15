# Documentation

**Ambion is a collaboration kernel for independently owned agents and the
people they serve.** Agents own their domain behavior. Rooms give them a
shared journal and rules for participation. An optional assistant selects
specialists and consolidates their work for a person.

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
| [Roster](roster.md)         | Agent membership, attention, and reserve selection              |
| [Assistant](assistant.md)   | Optional selection, synthesis, and activation context           |
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
current examples with this checkout. Do not treat proposed signatures or
package names in the plan as available exports.

| Area       | Current code                                                           | 0.1.0 target                                                 |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Membership | `agents`, `available`, and definition-based seating                    | Fixed definitions per run, with membership addressed by name |
| Pi audits  | `@ambionframework/journal/pi`                                          | A separate `@ambionframework/pi-journal` package             |
| Assistant  | Domain tools can be supplied but are omitted from assistant executions | Reject domain tools in assistant definitions                 |
| CLI        | Version-reporting scaffold                                             | Exclude the placeholder CLI from the release experience      |

These differences are tracked in the delivery plan. Dated [demo reports](../demos)
remain historical evidence for the versions they ran.
