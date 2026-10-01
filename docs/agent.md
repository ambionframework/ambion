# Definitions and tools

**An agent owns its instructions, model, tools, and domain behavior.** The
room owns the journal, roster, presence, execution authority, and exchange
rules. `agents` supplies every executable definition for one room run.

This page is not the entry point. Read [The room](room.md) first for the
overview, the glossary, and the room-wide mechanisms. The
[documentation index](README.md) links the other contracts.

## Definitions

Define each agent once and pass the definitions in `agents`.

```ts
const researcher = defineAgent({
  name: 'researcher',
  identity: 'Checks evidence and states uncertainty.',
  executor: pi({
    instructions: 'Use the supplied evidence. Speak when it changes the answer.',
    model: 'anthropic/claude-sonnet-5',
    tools: [lookup],
  }),
});

const room = await startRoom({
  name: 'delivery',
  agents: [researcher, editor],
  summary: 'editor',
});
```

`name` identifies the agent inside the room and on the journal. `identity` is
public roster text. `executor` names the loop the agent runs on and its
configuration. `pi`, `claude`, and `codex` are the executors that ship; see
[the Pi guide](pi.md), [the Claude guide](claude.md), and [the Codex
guide](codex.md). The `instructions`
are private model guidance. `model` names a model of that executor kind. `tools`
and `bundles` supply the agent's domain tools. `activationTokenLimit`
bounds the record one activation reads. Without a limit, an activation reads
the whole record the room serves. See `limits.context.messages` in
[History and limits](room.md#history-and-limits). `trace` sets what the
trace keeps of the agent's work; see
[the step vocabulary](executors.md#the-step-vocabulary).

**The room runs the token estimator.** `estimateTokens` is the name of an
estimator in the registry of the runtime, and the default name is `length`,
`Math.ceil(text.length / 4)`. A function does not cross the wire, so
`createRuntime({ estimators })` holds each other estimator by name, and a
definition carries the name alone. The room applies the limit inside the
view, so a seat on another host reads the same window. A name that the
registry does not hold fails `startRoom` and `resumeRoom`. The start is the
first point where the definition and the registry meet, and a failure there
reaches the host before any activation reads a view.

`summary` is an optional name from `agents`. It assigns closing work to that
ordinary agent. `assistant` accepts an ordinary agent definition and supplies
its registration, broadcast seat, and summary assignment. The optional
`@ambionframework/assistant` package supplies a default definition factory.
The shorthand introduces no separate role or tool set. See
[Default assistant](assistant.md) for configuration and behavior.

Definitions are values, captured for one run. On resume, the host supplies
executable definitions for every recorded agent name. The new run may use
updated definitions and add definitions to the reserve; live runs keep their
captured definitions.

## Tools

**A tool is an `AmbionTool`.** `defineTool` captures a TypeBox schema and
validates parameters before calling the typed function.

```ts
const lookup = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by id.',
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, ctx) => `Order ${id}: ${await orders.status(id)}`,
});
```

**Arguments that break the schema fail the call.** The error text is
`Invalid arguments for tool '<name>': <rules>.`, and `<rules>` names each
property path and the rule it breaks, such as `handles must not have fewer
than 1 items`. The model reads this text as a tool error.

Every ordinary activation receives `say`, `schedule`, `seat`, `unseat`,
`dismiss`, and `recall`, plus the tools from its definition. A closing
activation receives only `say`. `say` accepts `{ text, to?, refs? }`.
`schedule` accepts `{ after, text, refs? }` and writes a scheduled say
([Exchange](exchange.md#6-a-scheduled-say)). The room stamps the author,
activation, time, and routing facts. `seat` and `unseat` accept an agent name.
`dismiss` accepts `{ message }`, the seq of a scheduled say. The room
validates operations at the commit boundary.

**`recall` reads messages of the room by seq or by URI.** It accepts `{ refs
}`, 1 to 16 messages of this room. A ref is the seq as the record shows it,
such as `#12`, the bare seq `12`, or the URI
`ambion://room/<room>/message/<seq>`. The result gives one line for each
distinct ref: the message as the record renders it, or why the room gave none.
A ref to another room, a ref that names no message, and a seq that the view of
the activation cannot read each give a line. A ref that finds no message makes
the call a tool error, and the text still holds every line. `recall` reaches
every message that the purpose of the activation may read. A summary can fold
such a message, the token limit of the seat can leave it out, or the cap of
`limits.context.messages` can keep it below the view. `recall` commits
nothing, and it never moves the read position.

**A bundle adds tools, guidance, and a reminder.** `bundles: [shared.tools()]`
adds the tools of a resource, such as the workspace. A bundle's `remind`
gives text for each respond activation of a seat, such as the handles of
its running processes ([Processes](processes.md#reminders)).

**The kernel rejects two tools with one name.** [Resources](resources.md)
and [Workspace](workspace.md) state how a resource builds a bundle and how
the kernel flattens it. [Executors](executors.md#the-prompt-the-driver-renders)
states how the guidance follows the speaking policy.

**A tool learns where it ran from `ctx`.**
[Resources](resources.md#references-and-provenance) states what `ctx.room`,
`ctx.activation`, and `ctx.exchange` hold, and that the value grants no
authority.

**Spoken contributions require nonblank text.** The room refuses empty or
whitespace-only human messages, agent messages, and summaries before writing.
A refusal does not reserve the request key. Direct calls preserve accepted
text exactly; `say` trims its input. An agent can finish silently without `say`.

**A message has a size limit.** `limits.message.bytes` sets the most UTF-8
bytes one human message, agent message, or summary text carries. The default
is unbounded. The room refuses a longer text with the code `message_too_large`
before it writes. An agent reads the refusal as a tool error and can say a
shorter text. The limit counts `text` only.

**A ref is one absolute URI that a message cites.** A ref has a scheme, at
most 2048 characters, and no whitespace. A message carries at most 16 refs
without duplicates. `REF_LIMITS` holds both limits. The room stores the list
in order, omits an empty list, and never reads behind a ref. The `say` tool
trims each ref and drops blank ones. A direct `visit.send` keeps refs exactly
and refuses a bad one.

**The kernel owns the `ambion` scheme, and defines four forms.** The kernel
only builds and reads them. The room refuses an `ambion:` ref in any other
form.

| Form                                                                                            | Names                      | Build with                                       | Read with          |
| ----------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ | ------------------ |
| `ambion://room/<name>`                                                                          | A room                     | `roomUri(name)`                                  | `parseRoomUri`     |
| `ambion://room/<name>/message/<seq>`                                                            | One message of a room      | `messageUri(name, seq)`                          | `parseRoomUri`     |
| `ambion://workspace/<workspace>/snapshot/<digest>/<path>`                                       | The bytes of one file      | `snapshotUri(workspace, digest, path)`           | `parseSnapshotUri` |
| `ambion://workspace/<workspace>/repo/<namespace>/<name>[/branch/<b> or /tag/<t>]/commit/<hash>` | One commit of a repository | `commitUri(workspace, repository, commit, via?)` | `parseCommitUri`   |

**A seat can cite every message it reads.** Each line of the record starts
with the seq of its message, such as `#12`. The prompt states the room URI
and the URI of the message that opened the current exchange. An exchange has
no URI of its own: the URI of its opening message names it. The seq in a
message URI is the same `seq` a workspace mirror writes for that message, so
a reader finds the cited line in `/rooms/<name>/messages.jsonl` (see
[the mirror](workspace.md#mirror-a-rooms-messages)).

**A snapshot ref names bytes.** `<digest>` is the SHA-256 of the bytes, as 64
lowercase hex digits. `<path>` is the absolute workspace path that held them,
with each part percent-encoded. `parseSnapshotUri` accepts only the one form
that `snapshotUri` writes, so one file and one digest have one ref. No
decoded part of a path, a branch, or a tag holds a control character, so a
ref never carries a newline or a terminal escape. A workspace makes a
snapshot and keeps its bytes
([Snapshot a file](workspace.md#snapshot-a-file)).

**A commit ref names one commit.** `<hash>` is the full hash, 40 or 64
lowercase hex digits. `branch` or `tag` records the name that pointed at
the commit when the ref was made, so the ref keeps its meaning after the
branch moves. A workspace with a git backend makes the ref
([Cite a commit](git.md#cite-a-commit)).

**A workspace path is not a ref.** Cite a workspace file with a snapshot ref.
A `file:` URI or another URI that the application chooses names a file as
it is now, and it can change after the message cites it.
[Resources](resources.md) states how a resource change is cited.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

## Executors

[Executors](executors.md) holds the execution boundary, the steps, and the
trace.
