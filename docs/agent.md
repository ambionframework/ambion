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

const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'delivery',
  agents: [researcher, editor],
  summaryWriter: 'editor',
  execution: piExecution(),
});
```

**Names use one syntax.** Room, participant, workspace, and repository
namespace names start with a lowercase ASCII letter. Later characters are
lowercase ASCII letters, digits, or dashes.

**The neutral entry exports `isName` and `NAME_SYNTAX`.** `isName` checks the
complete string and rejects whitespace and line terminators. It has no length limit.
The workbench limits room names to 48 characters. `NAME_SYNTAX` exports the
unanchored pattern source for composition. Both exports come from
`@ambionframework/ambion/names`.

`name` identifies the agent inside the room and on the journal. `identity` is
public roster text. `executor` names the loop the agent runs on and its
configuration. `pi`, `claude`, and `codex` are the executors that ship; see
[the Pi guide](pi.md), [the Claude guide](claude.md), and [the Codex
guide](codex.md). The `instructions`
are private model guidance. `model` names a model of that executor kind. `tools`
and `bundles` supply the agent's domain tools. The `compose` tool joins
those tools in one call, and the `describe` tool returns their signatures.
`pi()`, `claude()`, and `codex()` add both to every seat ([Compose](compose.md)).
`trace` sets what the trace keeps of the agent's work; see
[Traces](traces.md#the-policy).

**`activationTokenLimit` bounds the record that one activation reads.**
Without a limit, an activation reads the whole record that the room serves.
`limits.context.messages` caps that record for every seat
([History and limits](room.md#history-and-limits)). The limit must be a
positive integer.

**`estimateTokens` counts the tokens against the limit.** It is a function
from a text to a token count. The default counts `Math.ceil(text.length / 4)`.
The definition holds the function, and the room calls it inside the view, so a
seat on another host reads the same window. `defineAgent` throws when
`estimateTokens` is not a function, and when it is set with no
`activationTokenLimit`. [Limits](limits.md#the-limits) lists both options with
the limits of the runtime.

`summaryWriter` is an optional name from `agents`. It names the ordinary
agent that runs summary activations. The `assistant` option supplies a
definition, its seat, and its summary writer in one step
([Default assistant](assistant.md)).

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
property path and the rule it breaks, such as `processes must not have fewer
than 1 items`. The model reads this text as a tool error.

Every respond activation receives `say`, `schedule`, `dismiss`, and
`recall`, plus the tools from its definition. [Roster](roster.md#seating-operations)
states when it also receives `seat` and `unseat`. A summary activation
receives only `say`. `say` accepts `{ text, to?, refs? }`.
`schedule` accepts `{ delaySeconds, text, refs? }` and writes a scheduled say
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

**A bundle gives an executor access to resource tools.** Pass it through
`bundles: [shared.tools()]`. [Tool bundles](resources.md#tool-bundles) owns
the bundle contract, guidance, reminders, and duplicate-name rule.
[Workspace](workspace.md#give-the-resource-to-an-agent) shows its use.

**A tool learns where it ran from `ctx`.**
[Resources](resources.md#references-and-provenance) states what `ctx.room`,
`ctx.activation`, and `ctx.exchange` hold, and that the value grants no
authority. `ctx.composeCall` holds the call id of the `compose` call that
made the call, and is absent for a direct call. It changes no permission
and no effect.

**Said contributions require nonblank text.** The room refuses empty or
whitespace-only human messages, agent messages, and summaries before writing.
A refusal does not reserve the request key. Direct calls preserve accepted
text exactly; `say` trims its input. An agent can finish silently without `say`.

**A message has a size limit.** `limits.message.bytes`
([Limits](limits.md#the-limits)) bounds the UTF-8 bytes of one human message,
agent message, or summary text. The room refuses a longer text with the code
`message_too_large` before it writes. An agent reads the refusal as a tool
error and can say a shorter text. The limit counts `text` only.

**A ref is one absolute URI that a message cites.** A ref has a scheme, at
most 2048 characters, and no whitespace. A message carries at most 16 refs
without duplicates. `REF_LIMITS` holds both limits. The room stores the list
in order, omits an empty list, and never reads behind a ref. The `say` tool
trims each ref and drops blank ones. A direct `visit.send` keeps refs exactly
and refuses a bad one.

**The kernel owns the `ambion://room/` forms.** The kernel builds and reads
them. The room refuses an `ambion://room/` ref in any other form. The room
checks no other ref beyond the rules above. The package that makes a ref reads
and checks it. A workspace makes the snapshot ref and the commit ref
([Snapshots](snapshots.md#snapshot-a-file), [Cite a commit](git.md#cite-a-commit)).

| Form                                 | Names                 | Build with              | Read with      |
| ------------------------------------ | --------------------- | ----------------------- | -------------- |
| `ambion://room/<name>`               | A room                | `roomUri(name)`         | `parseRoomUri` |
| `ambion://room/<name>/message/<seq>` | One message of a room | `messageUri(name, seq)` | `parseRoomUri` |

**A seat can cite every message it reads.** Each line of the record starts
with the seq of its message, such as `#12`. The prompt states the room URI
and the URI of the message that opened the current exchange. An exchange has
no URI of its own: the URI of its opening message names it. The seq in a
message URI is the same `seq` a workspace mirror writes for that message, so
a reader finds the cited line in `/rooms/<name>/messages.jsonl` (see
[the mirror](workspace.md#mirror-a-rooms-messages)).

**A workspace path is not a ref.** Cite a workspace file with a snapshot ref.
A `file:` URI or another URI that the application chooses names a file as
it is now, and it can change after the message cites it.
[Resources](resources.md) states how a resource change is cited.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

### Declared outputs

**A tool can declare the shape of its `details`.** The field
`compose: { output }` takes a TypeBox schema. `compose` binds a declared
tool as its checked `details`, and an undeclared tool as the text of its
content. The field `compose: false` leaves the tool out of `compose`.
`defineTool` and the check of a tool refuse any other value, and
`captureTool` copies the schema. [Compose](compose.md#bindings) states how a
binding uses the field.

**`ToolResult` takes the type of its details.** `TDetails` of
`ToolResult<TDetails = unknown>` defaults to `unknown`.
`AmbionTool` keeps `details` as `unknown`, because a list of tools holds
tools of many outputs.

**`defineTool` has two overloads.** A tool with `compose: { output }` must
return a `ToolResult` whose `details` is assignable to `Static` of the
schema. `tsc` reports the field that breaks it, such as `Property 'status'
is missing`. A tool with no declared output returns a string or a
`ToolResult`. Three types hold the options:

```ts
interface BaseToolOptions<P extends TSchema> {
  name: string;
  description: string;
  parameters: P;
  label?: string;
  prepareArguments?: (args: unknown) => Static<P>;
  executionMode?: 'sequential' | 'parallel';
}

interface PlainToolOptions<P extends TSchema> extends BaseToolOptions<P> {
  compose?: false;
  execute: (
    params: Static<P>,
    ctx: ToolContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
}

interface DeclaredToolOptions<
  P extends TSchema,
  O extends TSchema,
  D extends Static<O> = Static<O>,
> extends BaseToolOptions<P> {
  compose: { readonly output: O };
  execute: (params: Static<P>, ctx: ToolContext) => Promise<ToolResult<D>> | ToolResult<D>;
}
```

**The runtime check of a declared output stays.** A tool built by hand as
an `AmbionTool` gets no help from the compiler, so `compose` checks the
`details` of every call.

## Executors

[Executors](executors.md) holds the execution boundary, the steps, and the
trace.
