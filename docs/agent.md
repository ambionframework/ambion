# Definitions and tools

**An agent owns its instructions, model, tools, and domain behavior.** The
room owns the journal, membership, presence, execution authority, and exchange
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
are private model guidance. `model` names a model of that family. `tools`
and `bundles` supply the agent's domain tools. `activationTokenLimit`
bounds the record one activation reads, and `estimateTokens` counts tokens
against it. Without a limit, an activation reads the whole record the room serves. See
`limits.context.messages` in [History and limits](room.md#history-and-limits).
The seat runs `estimateTokens`, so it never crosses the wire. `trace` sets what the trace
keeps of the agent's work; see [the step vocabulary](executors.md#the-step-vocabulary).

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

Every ordinary activation receives `say`, `seat`, and `unseat`, plus the tools
from its definition. A closing activation receives only `say`. `say` accepts
`{ text, to?, refs? }`. The room stamps the author, activation, time, and routing
facts. `seat` and `unseat` accept an agent name. The room validates operations
at the commit boundary.

**A bundle adds tools and guidance.** `bundles: [shared.tools()]` adds the
tools of a resource, such as the workspace.

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
without duplicates. The room stores the list in order, omits an empty list,
and never reads behind a ref. The `say` tool trims each ref and drops blank
ones. A direct `visit.send` keeps refs exactly and refuses a bad one.

**The room owns the `ambion` scheme.** `roomUri(name)` gives
`ambion://room/<name>`. `messageUri(name, seq)` gives
`ambion://room/<name>/message/<seq>`. `parseRoomUri` reads only these
canonical forms. The room refuses an `ambion:` ref that is not canonical. The
prompt states the room URI and the URI of the message that opened the
current exchange. The seq in a message URI is the same `seq` a workspace
mirror writes for that message, so a reader can find the cited line in
`/rooms/<name>/messages.jsonl` (see
[the mirror](workspace.md#mirror-a-rooms-messages)). A workspace path is not
a ref. Cite a file with a `file:` URI or another absolute URI that the
application chooses. [Resources](resources.md) states how a resource change
is cited.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

## Executors

[Executors](executors.md) holds the execution boundary, the steps, and the
trace.
