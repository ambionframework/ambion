# Trust

> A process that serves HTTP lets agents run supplied server code and read
> its port with `fetch`. The initial deployment trusts that workstation and code.
> Its device access follows the process account; a read-only HTTP API does
> not restrict its shell. Any agent of the workspace can read any running
> process with GET, because the loopback network of a workstation is shared.

The kernel is a record with rules. It governs who may write what to the
journal. It does not sandbox model behavior or external effects. Two tables
state the boundary: what one seat cannot do to the record, and what the
kernel does not defend. Each row names its owner page and its evidence.

## What one seat cannot do to the record

**The room decides at the commit boundary.** Authority and freshness
decide. The room does not screen the intent of a message. It stamps the
author, the recipient, and the range from the activation, so a forged field
cannot enter the record.

| Attempt                                        | The room's answer                                                                                                                               | Evidence                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speak under another name                       | The room stamps the author from the seat of the activation. `say` has no author field.                                                          | [Definitions and tools](agent.md), [`contribution-validation.test.ts`](../packages/ambion/test/contribution-validation.test.ts)                                                                                                                       |
| Commit after a newer message landed            | An ordinary say returns `missed`, and the seat reads again before it speaks. A scheduled say lands, and its answer lists the `unread` messages. | `speechFreshness` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [Durability](durability.md), [`commit-retry.test.ts`](../packages/ambion/test/commit-retry.test.ts)                                                   |
| Change the recipient or the range of a summary | The writer sets the text only. The room refuses a second summary for one person.                                                                | `coversExchange` and `coversClose` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [`summary.test.ts`](../packages/ambion/test/summary.test.ts)                                                                         |
| Schedule work as another seat or person        | A scheduled say goes to its author alone, and a returned say has no author. The say names no person.                                            | `scheduleRefusal` in [`room/scheduled.ts`](../packages/ambion/src/room/scheduled.ts), [`transition.test.ts`](../packages/ambion/test/transition.test.ts), [`journal-validation.test.ts`](../packages/ambion/test/journal-validation.test.ts)          |
| Post as the system                             | A seat has no tool that posts. `room.post` belongs to the host. A system message has no author, and the body schema refuses `from` on one.      | `post` in [`room/transition.ts`](../packages/ambion/src/room/transition.ts), [`journal-validation.test.ts`](../packages/ambion/test/journal-validation.test.ts), [`exchange-completion.test.ts`](../packages/ambion/test/exchange-completion.test.ts) |
| Dismiss the say of another seat                | A seat dismisses its own scheduled say alone. The host dismisses any scheduled say, and its entry has no author.                                | `dismissal` in [`room/scheduled.ts`](../packages/ambion/src/room/scheduled.ts), [`transition.test.ts`](../packages/ambion/test/transition.test.ts)                                                                                                    |
| Read the record of another room                | `recall` reads the room of the activation alone. A ref to another room gives a line, and the room reads nothing.                                | `recallTool` in [`execution/room-tools.ts`](../packages/ambion/src/execution/room-tools.ts), [`executor-tools.test.ts`](../packages/pi/test/executor-tools.test.ts)                                                                                   |
| Revive cancelled work                          | Work before the cancellation boundary loses publication authority.                                                                              | `survivesCancellation` and `beforeCancellation` in [`room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts), [`cancellation.test.ts`](../packages/ambion/test/cancellation.test.ts)                                                  |
| Unseat a fixed seat through the tool           | The room refuses. The host can still call `room.unseat`.                                                                                        | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                                                                                                                                                       |
| Seat or unseat with seating turned off         | The room refuses a seating intent from a seat. The host can still call `room.seat` and `room.unseat`.                                           | [Roster](roster.md#turn-off-seating-for-agents), [`contribution-validation.test.ts`](../packages/ambion/test/contribution-validation.test.ts)                                                                                                         |
| Seat a human name or an unknown name           | The room refuses.                                                                                                                               | [Roster](roster.md), [`fixed-definitions.test.ts`](../packages/ambion/test/fixed-definitions.test.ts), [`room.test.ts`](../packages/ambion/test/room.test.ts)                                                                                         |

## What one seat can do to another

**These actions are by design.** Correctness rests on freshness. The room
does not restrict who may address or steer whom.

| Action                                                | Effect                                          | Evidence                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Unseat an agent that is not fixed                     | The agent leaves the roster at the next commit. | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                     |
| Seat an agent from the reserve                        | The agent joins at its attention.               | [Roster](roster.md), [`roster.test.ts`](../packages/ambion/test/roster.test.ts)                                     |
| Address anyone, including a person who is absent      | The message enters the record for that person.  | [Presence](presence.md), [`presence.test.ts`](../packages/ambion/test/presence.test.ts)                             |
| Steer a working seat with a message it did not author | The driver delivers the line into the pass.     | [Definitions and tools](agent.md), [`steering-delivery.test.ts`](../packages/ambion/test/steering-delivery.test.ts) |

## Roster authority

**The room owns the roster.** An agent changes it only by name, through
`seat` and `unseat`. A fixed seat resists the tool. The host always keeps
`room.unseat`, and can start the room with `seating: false` to remove both
tools. [Roster](roster.md) owns the rules and the attention scale.

## What the kernel does not defend

| Not defended                          | Why it is the application's concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where it is stated                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Prompt injection                      | The `text` of a message is data that a model may act on. The room screens emptiness and size only. A system message from the host carries text from outside the room, and the prompt names it as an event with no direction. The host owns what it posts.                                                                                                                                                                                                                                                                                                                                                                                                                                            | [Definitions and tools](agent.md)                                                                 |
| Tool and provider side effects        | The room does not run an effect once. A call can repeat after a timeout or a cancel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [Durability](durability.md) section 5                                                             |
| Secrets in transcripts                | The record keeps every token. The logger receives tool output. The byte cap limits size only. Pi writes each session, tool output included, to a JSONL file under `sessionDir` on the local disk. By default that is a directory in the shared OS temporary directory, with access for its owner only.                                                                                                                                                                                                                                                                                                                                                                                               | [Durability](durability.md), [Executors](executors.md), [Pi](pi.md#policy-and-the-trust-boundary) |
| A shell on a workstation              | An agent runs a real shell with network access. The account permissions on the server contain it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Workstation](workstation.md#trust)                                                               |
| Skill files on a just-bash workspace  | The just-bash backends share one filesystem with no owners, so any agent can edit the copy of another agent's skills. An edit that keeps the manifest lasts until the set changes. On a workstation, the account permissions contain it.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [Skills](skills.md#separation-and-trust)                                                          |
| What a ref points at                  | A ref is agent text. The room checks its grammar and never reads behind it. A ref can name any host, any file, or a snapshot or a commit of another workspace. The room does not check that a cited commit exists. A host that opens a ref resolves it against what it owns. The Workbench opens a snapshot, a commit, a file, or a table of its own workspace, and a room or a message that it hosts. It marks any other ref.                                                                                                                                                                                                                                                                       | [Definitions and tools](agent.md), [Example](example.md)                                          |
| Snapshot objects in the default store | On just-bash, the default object store is a folder with no owners, so any agent can change a file under `layout.snapshots`. `readSnapshot` and `restore` refuse bytes whose SHA-256 differs from the digest in the ref. On a workstation, only the host account writes the folder. Over S3, only the host holds the credential, and a put never rewrites an object. Two workspaces that share an S3 prefix share their objects, so give each workspace its own prefix. An object has no reader list: any agent of the workspace that knows a ref can `restore` it, so a snapshot cited in a direct message is readable by every agent.                                                               | [Workspace](workspace.md#the-object-backend)                                                      |
| Git on a workstation                  | The forced command `serve` and the account permissions restrict pushes to the agent's forks and shared repositories. An agent key works only from the loopback address, until it expires. A key that an agent copies into the record lets any account on the server push to that agent's repositories until then.                                                                                                                                                                                                                                                                                                                                                                                    | [Workstation git](workstation-git.md#trust)                                                       |
| Writes to shared git repositories     | Every workspace agent can push any content. A hook refuses deletion and non-fast-forward updates of the default branch; other branches can be rewritten or deleted. Commit authors on the workstation are client supplied; the authenticated pushing agent is recorded in the reflog.                                                                                                                                                                                                                                                                                                                                                                                                                | [Git](git.md#shared-repositories), [Workstation git](workstation-git.md#trust)                    |
| Writes to the shared database         | The guard of the append-only tables keeps each row and its provenance, and refuses every trigger of an agent. It does not keep the database open for writes. One agent can stop the INSERTs of every agent with ordinary DDL, for example a UNIQUE index on a constant expression, or `PRAGMA foreign_keys = ON` on a schema with `REFERENCES`. The PRAGMA stays on for later calls. Another agent can drop the index or set the PRAGMA back. The guard refuses the statements that it names, so an agent that runs SQL can still lift it with a statement that it does not name, for example `PRAGMA temp_store`, which drops the TEMP triggers of the guard. The backlog holds an allow-list (F1). | [Workspace](workspace.md#records-append-only-tables-with-provenance)                              |
| Hostile code in a runtime             | The runtime limits the names that code reaches, and it is not a security boundary against hostile code. `quickjsRuntime` shares the process of the host. `processRuntime` runs a child under `--permission`, and an ArrayBuffer is outside its memory bound.                                                                                                                                                                                                                                                                                                                                                                                                                                         | [Compose](compose.md#the-runtime)                                                                 |

## What each harness exposes

**Every executor kind reaches the world through the same tools.** The workbench team runs
one seat on Pi, one on the Claude Agent SDK, and one on Codex. One
list of `bundles` serves every seat, so each one holds the room tools, the
workspace tools, the instrument tools, and the one bundle of the canvas. No
seat holds another tool.

| Kind   | On                             | Off                                    | How the package enforces it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Test that guards it                                                                                                                                                                      |
| ------ | ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi     | Room tools and workspace tools | Everything else; Pi has no native tool | The executor gives the model the room tools and the tools of `bundles` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `examples/workbench/test/live/tool-set.test.ts`                                                                                                                                          |
| Claude | Room tools and workspace tools | Every built-in tool of Claude Code     | The executor passes an empty `--tools` list, an allow list of the tools of the seat, the mode `dontAsk`, no permission callback, and `verbatimPrompts`. It refuses an executable older than 2.1.248, reads no settings, turns skills off, and runs the process in a scratch directory with its own `HOME` and config directory. The environment is an allowlist of the host variables, plus the `env` option. The process still runs as the host user. A compromise of it reaches every file that user can read, the credential in its environment, and the network. The seat has no tool for these | `packages/claude/test/policy.test.ts` on the fake executable; `packages/claude/test/live/hermetic.test.ts` and `examples/workbench/test/live/tool-set.test.ts` on the model              |
| Codex  | Room tools and workspace tools | Every native tool, and Code Mode       | The executor fixes the tool policy and replaces the model catalog entry; no option opens it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `packages/codex/test/options.test.ts` on the options; `packages/codex/test/binary.test.ts` on the wire; `packages/codex/test/live/exclusive.test.ts` and the workbench test on the model |

**What the live tests prove.** One tool set, one filesystem, and no native
tool rest on the live exclusivity tests. `tool-set.test.ts` lists the tools
of each seat that has a key, finds the same list for every seat with no
native tool in it, and shows that one seat reads a file another seat wrote.
It also shows that a seat cannot read `/etc/hosts`.
`packages/codex/test/live/exclusive.test.ts` does the same for a Codex seat.
Both tiers skip an executor kind with no key, and they run only on request.

**A Codex seat has no native tools, ever.** The Code Mode runtime of Codex
read the host filesystem outside the sandbox on Codex 0.155.1, and the
catalog of 0.158.0 still listed its tools. The executor patches it out of
every seat. See [Codex](codex.md#the-trust-boundary).

**The `config.toml` of the seat home is the responsibility of the host.**
The executor overrides each config key that the recipe names. A key that the
recipe does not name survives from that file by a deep merge. An extra
`[mcp_servers.<name>]` table starts a server with tools that reach the
host. A `features.<name> = true` entry turns on a feature that the recipe
does not list. The default home `~/.ambion/codex` holds no `config.toml`
until a person writes one. Write only keys that you trust into that file.

Each executor kind has a guide with its options and its tests. Read the
[Pi](../packages/pi/README.md), [Claude](../packages/claude/README.md), and
[Codex](codex.md) pages, and [Executors](executors.md) for the
contract that all three meet.

## Compose

**A harness sees one tool for a compose call.** The room hosts `compose` as
one tool of the room server. The harness sees neither the nested calls nor
the `bash` that the code calls, so a harness hook cannot refuse one. The
`approve` hook of the `compose` option is the one hook that sees a compose
call. It reads `{ uses, code }` or `{ macro, hash, args }` before any code
runs, and an `approval` step records its answer
([Compose](compose.md#approval)).

**A nested call keeps the provenance of the compose call.** It runs the
ordinary tool with the same agent, room, activation, and exchange. A tool
gains no authority from the call.

## Harness memory

**A seat holds state the record does not show, for one exchange.** A tool
result that a seat read in one activation shapes its next activation in the
same exchange. [Exchange continuity](executors.md#exchange-continuity)
states the rule.

**Freshness governs speech in a kept session.** The driver records the
session on the `ended` lease entry, and the `Exchange` lists it as
`ExchangeActivation.session`. [Durability](durability.md) owns the entry
format.

Evidence: [`pi/test/continuity.test.ts`](../packages/pi/test/continuity.test.ts),
[`claude/test/memory.test.ts`](../packages/claude/test/memory.test.ts), and
the `session.*` files in
[`golden`](../packages/ambion/test/golden.test.ts).
