# Trust

The kernel is a record with rules. It governs who may write what to the
journal. It does not sandbox model behavior or external effects. Two tables
state the boundary: what one seat cannot do to the record, and what the
kernel does not defend. Each row names its owner page and its evidence.

## What one seat cannot do to the record

**The room decides at the commit boundary.** Authority and freshness
decide. The room does not screen the intent of a message. It stamps the
author, the recipient, and the range from the activation, so a forged field
cannot enter the record.

| Attempt                                        | The room's answer                                                                      | Evidence                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speak under another name                       | The room stamps the author from the seat of the activation. `say` has no author field. | [Definitions and tools](agent.md), [`contribution-validation.test.ts`](../packages/ambion/test/contribution-validation.test.ts)                                                                                                                         |
| Commit after a newer message landed            | The commit returns `missed`. The seat reads again before it speaks.                    | `speechFreshness` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [Durability](durability.md), [`commit-retry.test.ts`](../packages/ambion/test/commit-retry.test.ts)                                                     |
| Change the recipient or the range of a summary | The writer sets the text only. The room refuses a second summary for one person.       | `coversExchange` and `coversClose` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [`summary.test.ts`](../packages/ambion/test/summary.test.ts), [`multi-summary.test.ts`](../packages/ambion/test/multi-summary.test.ts) |
| Revive cancelled work                          | Work before the cancellation boundary loses publication authority.                     | `survivesCancellation` and `beforeCancellation` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [`cancellation.test.ts`](../packages/ambion/test/cancellation.test.ts)                                                    |
| Unseat a fixed seat through the tool           | The room refuses. The host can still call `room.unseat`.                               | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                                                                                                                                                         |
| Seat a human name or an unknown name           | The room refuses.                                                                      | [Roster](roster.md), [`fixed-definitions.test.ts`](../packages/ambion/test/fixed-definitions.test.ts), [`room.test.ts`](../packages/ambion/test/room.test.ts)                                                                                           |

## What one seat can do to another

**These actions are by design.** Correctness rests on freshness. The room
does not restrict who may address or steer whom.

| Action                                                | Effect                                          | Evidence                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Unseat an agent that is not fixed                     | The agent leaves the roster at the next commit. | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                     |
| Seat an agent from the reserve                        | The agent joins at its attention.               | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                     |
| Address anyone, including a person who is absent      | The message enters the record for that person.  | [Presence](presence.md), [`presence.test.ts`](../packages/ambion/test/presence.test.ts)                             |
| Steer a working seat with a message it did not author | The driver delivers the line into the pass.     | [Definitions and tools](agent.md), [`steering-delivery.test.ts`](../packages/ambion/test/steering-delivery.test.ts) |

## Membership authority

**The room owns membership.** An agent changes it only by name, through
`seat` and `unseat`. A fixed seat resists the tool. The host always keeps
`room.unseat`. [Roster](roster.md) owns the rules and the attention scale.

## What the kernel does not defend

| Not defended                   | Why it is the application's concern                                                                | Where it is stated                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Prompt injection               | The `text` of a message is data that a model may act on. The room screens emptiness and size only. | [Definitions and tools](agent.md)                      |
| Tool and provider side effects | The room does not run an effect once. A call can repeat after a timeout or a cancel.               | [Durability](durability.md) section 5                  |
| Secrets in transcripts         | The record keeps every token. The trace holds tool output. The byte cap limits size only.          | [Durability](durability.md), [Executors](executors.md) |
| A shell on a workstation       | An agent runs a real shell with network access. The account permissions on the server contain it.  | [Workstation](workstation.md#trust)                    |

## What each harness exposes

**Every family reaches the world through the same tools.** The workbench team runs
one seat on Pi, one on the Claude Agent SDK, and one on the Codex SDK. One
list of `bundles` serves every seat, so every seat holds the room tools and
the workspace tools and no other tool.

| Family | On                             | Off                                    | How the package enforces it                                                               | Test that guards it                                                                                                                      |
| ------ | ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pi     | Room tools and workspace tools | Everything else; Pi has no native tool | The executor gives the model the room tools and the tools of `bundles` only               | `examples/workbench/test/live/tool-set.test.ts`                                                                                          |
| Claude | Room tools and workspace tools | Every built-in tool of Claude Code     | With no `allowedTools`, the executor passes an empty `--tools` list and reads no settings | `packages/claude/test/policy.test.ts` on the fake executable; `examples/workbench/test/live/tool-set.test.ts` on the model               |
| Codex  | Room tools and workspace tools | Every native tool, and Code Mode       | `nativeTools: 'none'` sets the tool policy and replaces the model catalog entry           | `packages/codex/test/exclusive.test.ts` on the options; `packages/codex/test/live/exclusive.test.ts` and the workbench test on the model |

**What the live tests prove.** One tool set, one filesystem, and no native
tool rest on the live exclusivity tests. `tool-set.test.ts` lists the tools
of each seat that has a key, finds the same list for every seat with no
native tool in it, and shows that one seat reads a file another seat wrote.
It also shows that a seat cannot read `/etc/hosts`.
`packages/codex/test/live/exclusive.test.ts` does the same for a Codex seat.
Both tiers skip a family with no key, and they run only on request.

**`nativeTools: 'none'` turns off Codex Code Mode.** Its JavaScript runtime
reads the host filesystem outside the sandbox on Codex 0.155.1. See
[Codex](codex.md#the-trust-boundary).

Each family has a guide with its options and its tests. Read the
[Pi](../packages/pi/README.md), [Claude](../packages/claude/README.md), and
[Codex](codex.md) pages, and [Executors](executors.md) for the
contract that all three meet.

## Harness memory

**A seat with `memory: 'seat'` holds state the record does not show.** It
resumes one harness session across activations. With `memory: 'activation'`
the harness opens a fresh session each time. The default is `activation`.

**Freshness governs speech in both modes.** The room never reads the
option. The driver records the resumed session on the `ended` lease entry,
and the exchange view lists it as `ExchangeActivation.session`.
[Durability](durability.md) owns the entry format.

Evidence: [`pi/test/memory.test.ts`](../packages/pi/test/memory.test.ts),
[`claude/test/memory.test.ts`](../packages/claude/test/memory.test.ts), and
the `session.*` files in
[`golden`](../packages/ambion/test/golden.test.ts).
