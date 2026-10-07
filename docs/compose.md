# Compose

**Status: the current contract of 0.7.0.** Every Pi, Claude, and Codex seat
has the `compose` tool and the `describe` tool, with `quickjsRuntime()` by
default. A seat cannot turn them off. The main entry exports the types of the
option and `COMPOSE_GUIDANCE`.
Skill [macros](macros.md) run by name. The package
`@ambionframework/compose/runtime` holds `quickjsRuntime` and `processRuntime`,
and both pass `composeRuntimeConformance`.

**Macros are the main use of `compose`.** A skill stores a procedure as a
[macro](macros.md), and the model runs it by name with arguments. The model
writes no code, and it reads only the value that the macro returns. In the
live runs, the seats of Claude and Codex ran the macro with no code and no
exploration calls.

**Free code serves precision and chains of typed tools.** The agent calls
`compose` with the tools that it uses and short code. The code passes the
result of one tool into the next, and returns one value to the model. The
data between the calls stays out of the context of the model. The live runs
measured no token saving for free code. The full catalog and the exploration
calls of the seat cost more input tokens than the data that the call kept
out of the context. The description of `compose` now holds a compact list,
and `describe` gives the signatures on demand ([Catalog](#the-catalog)).

**Code with no tools calculates and transforms data.** `compose` runs on a
general JavaScript runtime. A call with `uses: []` binds no tool. It
calculates, and it sorts, groups, and reshapes data that the model already
holds. The guidance names these uses to the model.

```js
// compose({ uses: [], code })
const sales = [
  { region: 'north', amount: 120.5 },
  { region: 'south', amount: 80.25 },
  { region: 'north', amount: 42 },
];
const totals = {};
for (const { region, amount } of sales) totals[region] = (totals[region] ?? 0) + amount;
return Object.entries(totals).sort((a, b) => b[1] - a[1]);
```

```js
// compose({ uses: ['sql', 'snapshot'], code })
const drift = await tools.sql({ sql: "SELECT path FROM runs WHERE label = 'drift'", rows: 500 });
const { refs } = await tools.snapshot({ paths: drift.rows.map((row) => row.path) });
return { runs: drift.count, refs };
```

**The model reads the returned value alone.** Here that is a count and the
snapshot refs. The rows and the paths stay in the compose call. The agent
then cites the refs in a `say`, as it does today.

**The tools stay the same tools.** Each nested call runs the ordinary
tool, with its schema, its checks, its authority, and its provenance. A
tool needs no change to take part. A tool can declare the shape of its
result, so that code and the model can depend on it.

**Code is the glue between tools.** It reaches the world through its
bindings alone. It has no clock, no random source, no timer, no import,
and no I/O. A compose call is a function of the values that its tools
return.

## Terms

The journal already uses `composition` for the entry that holds the
roster. This page never uses that word.

| Term         | Meaning                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| compose call | One call of the `compose` tool, and the run of the code that it carries.            |
| nested call  | One call of a tool that the code of a compose call makes.                           |
| binding      | One tool as an asynchronous function inside the code: `tools.<name>`.               |
| catalog      | The signatures of the tools that a seat can bind. The `describe` tool renders them. |
| macro        | A compose program that a skill stores. A compose call runs it by name.              |
| runtime      | The pluggable backend that evaluates the code. It holds no tool.                    |
| ledger       | The nested calls of one compose call, in order, with the outcome of each.           |

## The compose tool

**`compose` takes free code, or the name of a macro.**

```ts
type ComposeArguments =
  | {
      /** The tools this compose call uses. Only these are bound. */
      readonly uses: readonly string[];
      /** The body of an asynchronous function. Its return value is the result. */
      readonly code: string;
    }
  | {
      /** The name of a macro that a skill names: `<skill>/<macro>`. */
      readonly macro: string;
      /** The arguments of the macro. Absent arguments are `{}`. */
      readonly args?: JsonValue;
    };
```

**The tool schema is one object with optional fields.** A model
provider accepts no `anyOf` at the top of a tool schema. `resolveProgram`
checks the two forms. A call that gives `uses` and `code`, or `macro` and
`args`, is valid. Any other mix is a refusal with no ledger and no effect.
A seat with no macro gets the fields `uses` and `code` alone, so its schema
holds no field for a macro it cannot run.

**`uses` declares the tools before the code runs.** `compose` refuses a
name that the catalog does not hold. It checks `uses` first, then asks
the [approval](#approval), then evaluates the code. A macro holds its own
`uses`, so a macro call gives none. A refusal at either
step has no ledger and no effect. `compose` binds only the named tools.

**Code that reads an unbound name gets an error that names the fix.** The
runtime wraps `tools` so that a read of `tools.<name>` for any other name
throws. The message names the tool and
the bound names. It differs for three cases:

| Case                                       | Message                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| The seat has the tool, and `uses` omits it | `tools.wait is not bound. This call binds bash. Add wait to uses.`                         |
| The seat has no tool of that name          | `tools.kill does not exist. This seat has no tool named kill. This call binds bash, wait.` |
| The call binds nothing                     | The same two messages, with `This call binds no tool.`                                     |

`compose` gives the runtime the names of the seat tools that the call
leaves out in `unlisted`. The two runtimes share one guest script, so
both give the same message. The read of `then` and `toJSON` does not throw,
so `await tools` and `JSON.stringify(tools)` work. `'wait' in tools` is
false for an unbound name.

**`code` is a function body.** It runs as the body of an `async` function
with fresh local state. `await` works at the top level. `return` gives the
result. A body with no `return` gives `undefined`, and the model reads that
the compose call completed with no value.

**The returned value must be JSON.** `compose` renders it for the model as
compact JSON. A value that JSON cannot hold, such as a function or a
cycle, fails the compose call with an error that names the problem.

**Code that wants a partial result catches the error.** A compose call
returns one value or fails. Code that must report what it got before a
failure wraps its calls in `try` and returns that value:

```js
const done = [];
try {
  for (const path of paths) done.push((await tools.snapshot({ paths: [path] })).refs[0]);
} catch (error) {
  return { failed: error.message, done };
}
return { done };
```

**A completed compose call returns a tool result.** `content` holds the
rendered value, and a line for each nested call that settled after the
code returned. `details` holds a `ComposeResult`:

```ts
interface ComposeResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly value?: JsonValue;
  readonly error?: { readonly message: string; readonly call?: string };
  readonly calls: readonly LedgerEntry[];
}

interface LedgerEntry {
  readonly call: string; // The id of the nested call.
  readonly tool: string;
  readonly status: 'completed' | 'failed' | 'pending';
}
```

**A failed or cancelled compose call throws.** Its message renders the error
and the ledger, and the signatures of the tools that the failure names
([Catalog](#the-catalog)). Every executor kind turns a thrown error into an error result
with that message. The model then knows which calls completed. It knows which
effects can stand. The error is a `ComposeFailure`, an internal class of the
core that the main entry does not export. Its `details` hold the
`ComposeResult`, and no executor passes them on. The ledger never holds the
input or the output of a call.

**The message shows the result of each completed call.** The code that
failed has lost the values that its calls returned, such as the handles of
processes that it started. The message gives each completed call a line
`  result: <JSON>` under its ledger line, so the model can recover what the
code started. The value is the binding value that the code received. A
failed or pending call shows no result. A room tool shows none either: its
result reaches the model only under `Room tools reported:`. A cancelled compose call, a time limit, and
a failure show their results in the same way.

```text
The compose call failed: tools.wait is not bound. This call binds bash. Add wait to uses.
Calls, in the order that the code made them:
- c1.1 bash: completed
  result: {"process":{"id":"p1"}}
- c1.2 bash: completed
  result: {"process":{"id":"p2"}}
```

**The results have two bounds.** One result shows at most 4096 bytes of
JSON. All results together show at most `compose.limits.bytes`. A cut result
reads `result: cut to at most <shown> of <full> bytes:` and then its first bytes,
cut at a character. A result past the total reads `result: omitted, because
the results above fill <bytes> bytes.`

**The content is the contract.** Claude and Codex host a definition tool as
a `BoundTool`, and a `BoundTool` keeps the content alone
([Executors](executors.md#the-room-tools)). The `ComposeResult` of a
completed call reaches a Pi seat in `details`, and the trace keeps it. On
Claude and Codex, the model and the trace read the rendered content.

## Limitations

**This section gathers what `compose` cannot do.** Each point links to the
section that states it in full.

- **Some tools never bind.** `compose` and `describe` do not bind
  themselves, and a tool with `compose: false` does not bind. A summary activation has no
  `compose` or `describe` tool ([What a compose call binds](#what-a-compose-call-binds)).
- **A room tool binds only in an activation.** A direct `invoke` of the
  `compose` tool refuses a call that uses a room tool
  ([What a compose call binds](#what-a-compose-call-binds)).
- **The say calls of one compose call run one after another.** The room
  refuses a say that starts before the previous say lands
  ([Parallel calls](#parallel-calls)).
- **Four limits bound a compose call.** The defaults are 64 nested calls,
  8 calls at a time, 65,536 bytes of returned JSON, and 120,000 ms of wall
  time. The activation deadline ends a call sooner. The description of
  `compose` shows the values of the seat ([Limits](#limits)).
- **Each runtime adds limits of its own.** `quickjsRuntime` limits the
  heap to 64 MiB and the code to 10,000 ms of CPU. `processRuntime`
  limits the old space of the child heap to 64 MiB. The description of
  `compose` does not state them ([The runtime](#the-runtime)).
- **The code has no ambient authority.** It has no clock, no random
  source, no timer, no import, and no I/O except through tools
  ([The runtime](#the-runtime)).
- **The runtime is not a security boundary.** Hostile code can pass the
  limits of its names ([Trust](trust.md#what-the-kernel-does-not-defend)).
- **A completed nested call keeps its effect.** A failure or a cut undoes
  nothing, and a rejected call cancels no sibling
  ([Failure, cancellation, and effects](#failure-cancellation-and-effects),
  [Parallel calls](#parallel-calls)).
- **Image parts of a result do not reach the code.** A binding gives
  `details`, or the text of `content` ([Bindings](#bindings)).
- **A tool without a declared output binds as text.** The code parses the
  string ([Bindings](#bindings)).
- **A harness hook does not see a nested call.** Only the `approve` hook
  of the `compose` option sees the compose call ([Approval](#approval)).
- **Free code saved no tokens in the live runs.** The runs held a chain
  task and a fan-out task. The full catalog and the exploration calls cost
  more input tokens than the data that the code kept out of the context. A
  macro runs by name with no code and no exploration, so it is the main
  use ([Catalog](#the-catalog)).
- **The description of `compose` shows no signature.** It lists each tool
  with a typed result by the name of its result type. The model calls
  `describe` for the signatures, and a failed compose call shows the signature of the tools
  that it names ([Catalog](#the-catalog)).
- **A compose call fails in workerd until a runtime for workerd
  exists.** A worker seat has both tools
  ([The runtime](#the-runtime)).

## The catalog

**The description of `compose` lists the bindings with a typed result by
name and result type.** It holds no signature. The core builds one entry for
each tool that a seat can bind and that declares an output, in the order of
the tools. One sentence says that the other tools return text:

```text
Tools that code can bind, each with the type of its result: read -> ReadResult, sql -> SqlResult. The other tools return text. seat and unseat bind only when your tool list holds them.
```

A seat with no typed tool reads `Every tool that code can bind returns
text.` in place of the list.

| The tool declares       | The line shows                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------- |
| An output with an `$id` | The `$id`, such as `sql -> SqlResult`.                                                  |
| An output with no `$id` | `object`, `array`, or the primitive type of the output. A `string` output has no entry. |
| No output               | No entry. The binding gives the text.                                                   |

**`describe` renders the signatures on demand.** It is a counterpart of
`compose` on every seat that has `compose`. It takes `tools`, a non-empty
list of bindable tool names, the room tools `say`, `schedule`, `recall`,
`seat`, `unseat`, and `dismiss` included. It returns the TypeScript
signature of each named tool, in the order named, and the named types before
them. It runs no tool and has no effect. Its own description tells the model
to call it before code that reads the fields of a result.

```ts
interface DescribeArguments {
  /** The names of the tools to describe, such as ["sql", "snapshot"]. */
  readonly tools: readonly string[];
}
```

**`describe` refuses a name that code cannot bind.** An unknown name, a tool
with `compose: false`, `compose`, and `describe` each fail the call. The
error names the refused tools and lists the bindable names. The result of a
refusal is an ordinary tool error, so the model corrects the list and calls
again.

**`describe` is fixed when the agent is defined.** The kernel builds it with
`compose` from the same catalog, so the tool list of a seat is the same in
every activation. The kernel reserves the name `describe` as it reserves
`compose`. A definition that brings a tool of that name fails with
`invalid_tool`. `describe` is not bindable: a compose call cannot call it.

**A failed compose call appends the signatures that it needs.** A wrong
guess surfaces where a compose call fails, so the failure text ends with the
signature of the tool that the failure names. Two tools can appear: the tool
of the nested call that failed, and the tool that the code read as
`tools.<name>` while `uses` left it out. A name that the seat does not have
adds no signature. A failure with no named tool adds none.

```text
The compose call failed at call c1.2: The archive is closed.
Calls, in the order that the code made them:
- c1.1 echo: completed
  result: "a"
- c1.2 broken: failed
Signatures of the tools that the failure names:
declare const tools: {
  /** Always fails. */
  broken(args: {}): Promise<string>;
};
```

The example of the typed catalog follows. `describe` returns this form for
the tools that a call names. The example shortens the descriptions.

```ts
/** One order. */
type Order = {
  id: string;
  status: 'open' | 'delayed' | 'shipped';
  /** The promised day of delivery. */
  eta?: string;
};
declare const tools: {
  /** Run statements on the shared database. */
  sql(args: {
    /** One or more SQL statements. The last query gives the preview. */
    sql: string;
    /** How many rows the preview shows, up to 1000. The default is 50. */
    rows?: number;
  }): Promise<{
    /** How many rows the last statement gave, in all. */
    count: number;
    /** The preview rows: the first rows of the last statement. */
    rows: Record<string, string | number | null>[];
  }>;
  /** Fetch an order by id. */
  lookup_order(args: { id: string }): Promise<Order>;
  /** Write a note. */
  note(args: { text: string }): Promise<string>;
};
```

**A field description becomes a doc comment.** The renderer writes the
`description` of a property before the field, in the input and in the
output schema. An object with a described field renders one field on each
line, and the indentation follows the nesting. An object with no described
field renders on one line. A comment end in a description is escaped. An
array item and a record value show no description.

**A schema with an `$id` becomes a named type.** The renderer writes it
once as `type <Id> = ...;` before `declare const tools`, and every use shows
the name. TypeBox writes the `$id` on the node where the schema is used, so
the check of the schema needs no context. The renderer never throws, because
it must not stop `defineAgent`. A schema with an `$id` that is no TypeScript
identifier renders inline. When a different schema arrives under an `$id`
that is taken, it renders inline, and the first schema keeps the name. The
process and workspace tools use this for the type of each declared output,
such as `SqlResult`, `ProcessResult`, and `FetchResult`, and for `Process`
and `Truncation`, which several tools share
([Workspace](workspace.md#declared-outputs)).

**The renderer covers the JSON Schema that TypeBox writes.** An object, an
array, a union, a literal, and the primitive types each have a TypeScript
form. A schema with no form renders as `unknown`. The input schema stays
the authority: `compose` checks every argument against it.

**The compact list keeps the cost of an unused `compose` small.** One
provider request repeats the whole tool list, and the live runs made 3 to 6
requests for each activation. The full catalog of a workspace seat with files,
processes, snapshots, SQL, and git held about 14,000 characters in the
description of `compose`. The compact list of the same seat holds about 1,200
characters with the contract and the limits, and `describe` holds about 200.
The first live runs measured the full catalog at 9,000 to 26,000 input tokens
more for each activation. A model
that composes pays one more call to `describe`, or reads the signature in a
failure.

## Guidance

**The model decides when to compose.** The name of the tool gives little
of that decision. The guidance gives the rest. It states when a compose
call helps, and when a direct call is the right call. A compose call helps
when a result feeds a later call, or when the model needs a part of a large
result. The guidance names no count of calls.

**`compose` adds guidance, as a bundle does.** `describeExecutor` joins
the guidance of `compose` after the guidance of the bundles, in the
`guidance` field of the executor. The prompt renders it after the respond
policy, as it renders the guidance of every bundle
([Executors](executors.md#the-prompt-the-driver-renders)). The description of
`compose` holds its uses, the limits, and the list of bindings.

**The text is `COMPOSE_GUIDANCE`.** `compose.ts` holds it, and the main
entry exports it. `ComposeOptions.guidance` replaces it and the process
paragraph, as the `respondPolicy` option replaces `DEFAULT_RESPOND_POLICY`. The text tells the model to plan
first, to compose when a result feeds a later call or the model needs a
part of a large result, and to call `describe` for a tool whose result has
fields that the code reads. The text follows:

```text
Plan the tool calls of a task before you make the first call. Use one
compose call when a result feeds a later call, or when you need a part of
a large result. This includes say and the other room tools. Make a call
directly when it stands alone, or when you must judge its result before
the next call.

To write a compose call, call describe for each tool whose result has
fields that you read. Put the tools in uses, and the body of an async
function in code. Each tool is tools.<name>. Read the fields of each
result, and do not parse text.

Use compose also to explore. To learn the size or the shape of data,
return a count, a few fields, or a short sample from code. Do not read
large results one direct call at a time. Code with uses: [] calculates,
sorts, groups, and reshapes data that you already hold.

The say calls of one compose call run one after another. When the room
refuses a say because the record moved, the binding rejects, and the
compose result shows the new lines. Read them before you speak again.
A seat that starts before a say in one Promise.all lands first, and the
room refuses the say. Await the seat, then say.

When the task expects a tool to fail, catch the failure with
.catch((error) => error.details) and read the details.

Return only the values that you need to read. The code has no clock,
no random source, and no I/O except through tools. A failed compose
call lists each call, its outcome, and the result of each completed
call. A completed call can have had an effect, so read the list before
you call a tool again.
```

**The guidance follows the tools of the seat.** `describeExecutor` builds
the text once, from the tools that the definition holds, so the tool list
and the guidance of a seat do not change between its activations. A seat
that holds `bash` gets one more paragraph. It tells the model to call
`wait` on each process that the code starts, before the code returns. A seat
with no `bash` gets no word about processes. The rule that a failed tool
rejects, and that `error.details` holds its result, stays in the
description of `compose`.

**The guidance lists the macros of the seat.** A seat with macros gets
one more block after the text. The block holds one line for each macro:
its name, a colon, and its description on one line. A seat with no macro
gets no block. `ComposeOptions.guidance` replaces the text and keeps the
block, because the block is data of the skills. The description of
`compose` and the guidance of the skills do not change.

```text
The macros of your skills. When a skill names one, run it with compose({ macro, args }) and write no code. The macro holds the code and names its own tools:
- lab-drift/snapshot-drift: Snapshot the files of every run with a label. Returns the count and the refs.
```

**The description of `compose` holds its uses, the limits, and the list of
bindings.** The first line is `Run JavaScript that calls your tools as
tools.<name>, in one call. Use it when a result feeds a later call, or when
you need a part of a large result. You read only the value that the code
returns.` A
block of three lines follows it. The first line gives the limits of the seat:
`compose.limits` after the defaults. The second line states that a
binding rejects with an `Error` when its tool fails, and that
`error.details` holds the details of the tool. It states that a rejection
cancels no other call. The third line states that a compose call cannot start
a compose call, and that image parts do not reach the code. The guidance
holds the other facts, including that a completed call keeps its effect, so
no fact is in both places. The list of bindings ends the description. It
lists `seat` and `unseat` apart, as tools that bind only when the tool list
of the seat holds them.

## Macros

**`compose` runs a macro by name.** A call that gives `macro` and `args`
runs the code that a skill stores, under the `uses` of that file. The call
checks `args` against the schema of the macro, and asks `approve` with the
name, the hash, and the `args`. From the evaluation on, it is an ordinary
compose call. [Macros](macros.md) states the format, the steps, and the
limits.

**The trace records the call of a macro without its hash.** The
`tool_call` step of the `compose` call holds the input of the model:
`{ macro, args }`. The hash goes to `approve` alone. The `approval` step
holds the call id and the answer.

## Bindings

**A binding returns the declared output of its tool.** A tool declares the
output with a TypeBox schema:

```ts
interface AmbionTool {
  // The existing fields stay the same.
  readonly compose?: false | { readonly output: TSchema };
}
```

| `compose`            | The binding                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `{ output: schema }` | Returns `details`, after `compose` checks it against `schema`.       |
| absent               | Returns the text of `content`, with the text parts joined by a line. |
| `false`              | Does not exist. The tool is not in the catalog.                      |

**The definition keeps the field.** `defineTool` takes `compose` and puts
it on the tool. `captureTool` copies it, and captures the `output` schema
as it captures `parameters`. The check of a tool refuses a `compose` value
that is not `false` or an object with a TypeBox `output`.

**The binding returns one kind of value per tool.** A declared tool always
gives its `details`, and an undeclared tool always gives a string. The
list in the description of `compose` states which one. `details` with no declared schema has no
contract, so no binding exposes it. Image parts of `content` do not reach
the code.

**A declared output is checked at every call.** An invalid `details`
rejects the binding with an error. The error names the tool, the call, the
paths that break the schema, and the fact that the call completed. The
check undoes no effect and authorizes no retry. The ledger marks the call
`completed`, and the compose call fails at that point unless the code
catches the error.

**A failed call rejects its binding with an `Error`.** The error carries
the message that the model reads for a direct call. A workspace tool
throws a `ToolFailure` with `details`, such as the exit status of a
process that `wait` saw fail. The binding copies those `details` to
`error.details`, so the code reads the status without parsing text. The
error crosses to the runtime as the JSON `{ message, details? }`, and
the runtime builds the `Error` from it.

**`compose` sets `ToolContext.composeCall` on each nested call.**
[Definitions and tools](agent.md#tools) states the field.

```ts
interface ToolContext {
  // The existing fields stay the same.
  readonly composeCall?: string;
}
```

**The workspace tools declare their outputs.** `sql`, `snapshot`, `read`,
`restore`, `bash`, `cancel`, `wait`, `ps`, `repos`, `fork`,
and `fetch` set `compose: { output }`, and each output has an
`$id` that names its type. `write` and `edit`
bind as text, because the code needs only their success or
their rejection. [Workspace](workspace.md#declared-outputs) states
the shape of each output.

## Typing a declared output

**`defineTool` ties the return type of `execute` to the declared output.**
[Definitions and tools](agent.md#declared-outputs) states the two overloads
and `ToolResult<TDetails>`. A string, a missing field, or a value of the
wrong type fails `tsc`. [Definitions and tools](agent.md#declared-outputs) states the runtime check
of each call.

```ts
const Order = Type.Object({
  id: Type.String(),
  status: Type.Union([Type.Literal('open'), Type.Literal('delayed'), Type.Literal('shipped')]),
  eta: Type.Optional(Type.String()),
});

const findOrder = defineTool({
  name: 'find_order',
  description: 'Fetch an order by id, as data.',
  parameters: Type.Object({ id: Type.String() }),
  compose: { output: Order },
  execute: async ({ id }) => {
    const order = await orders.get(id); // Static<typeof Order>
    return { content: [{ type: 'text', text: `Order ${id}: ${order.status}` }], details: order };
  },
});
```

**`fromPiTool` takes no output declaration.** A native Pi tool binds as
text.

## What a compose call binds

**A compose call binds the tools of the definition.** It binds each tool
that the definition holds after it flattens `tools` and `bundles`, and
omits each tool that sets `compose: false`. `compose` builds the catalog
once, when the definition is made.

**The room tools bind in a respond activation.** The catalog lists
`say`, `schedule`, `recall`, `seat`, `unseat`, and `dismiss` for every seat
that has `compose`, with the schemas that the room gives them. The
catalog does not change between activations. Code binds them as text, as it
binds a tool with no declared output. Use them to say to many
participants, seat several agents, or recall many refs in one call.

**Only the room tools of the activation bind.** An activation holds `seat`
only when the reserve held an agent as the room composed. It holds neither
`seat` nor `unseat` in a room started with `seating: false`. The executor
fixes its description when it is defined, before the room exists. The
description lists every room tool, and says that `seat` and `unseat` bind
only when the tool list holds them. The `describe` tool still renders both.
A call that uses a room tool that the activation lacks fails before the
code runs. The error states that the room does not offer the tool.

**The driver hands the room tools to the compose call.** It passes the
room tools of the activation to `invokeTool` and `invokeChecked`,
beside the step sink. The room tools stay bound to the activation, so a
nested call commits with the read position of the activation. A direct
`invoke` of `compose` has no activation. A call that uses a room tool then
fails before the code runs: the refusal states that the room tools need an
activation.

**A room tool that fails rejects its binding.** The error message holds the
text that the model reads for a direct call. A say that the room refuses
because the record moved rejects with the refusal and the missed lines.
Code can catch it.

**The model reads the record through the compose result.** The model reads
no nested result. After the value, the content of the compose result lists
each nested room-tool result that carries lines of the record or is an
error, under `Room tools reported:`. A failed or cut compose call lists
them too. The activation counts the record as read through a nested call
when the compose result reaches the model. A nested call id is the call id
of `compose`, a dot, and the place of the call. It is the commit key of
the nested call. The compose result lists the ids that it shows, and the
activation counts only those nested calls as read. A nested `say` has no
cancel, so the compose call waits for each running room-tool call to settle
before it builds the result, also after a time limit or a cut.

**Code reads the record with `recall`.** A workspace mirror also writes the
messages of a room to `/rooms/<name>/messages.jsonl`
([Workspace](workspace.md#mirror-a-rooms-messages)).

**`compose` does not bind itself.** A compose call cannot start a compose
call.

**A summary activation has no `compose`.** It receives only `say`, as
[Definitions and tools](agent.md#tools) states.

## Parallel calls

**A call starts when the code calls its binding.** The binding returns a
promise at once. Code that starts several calls before it awaits them runs
them together. `Promise.all` and `Promise.allSettled` join the results.

```js
// compose({ uses: ['lookup_order'], code })
const orders = await Promise.all(ids.map((id) => tools.lookup_order({ id })));
return orders.filter((order) => order.includes('delayed'));
```

**`compose.limits.concurrent` caps the calls that run together.** A call
past the cap waits in a queue, in the order that the code made it. It
starts when a running call settles. The ledger lists the calls in the
order that the code made them.

**A tool with `executionMode: 'sequential'` runs one call at a time.**
`compose` runs the calls of such a tool one after another, inside one
compose call, in the order that the code makes them. Calls of other tools
still run beside them.

**`say` is sequential.** Two says that start together carry the same read
position, and the say lock of the room refuses the second. `compose` starts
the next say after the previous say lands, and the landed say raises the
read position. Code can use `Promise.all` over `say` calls, and the says
land in the order that the code made them. `schedule`, `seat`, `unseat`,
`dismiss`, and `recall` run together, up to the cap. A seating or a dismissal that lands counts as read, because it is the own
act of the activation. A line of another participant that lands before a say
still makes the room refuse that say as missed.

**A seat that starts beside a say can make the say miss.** `Promise.all` of
a `seat` before a `say` starts both with the same read position. The seat
commit lands first, and its entry is past that position. The room refuses
the say as missed. Run the seat, await it, and then say: the landed seat
counts as read, and the say carries the new position. A line of another
participant that lands between the seat and the say makes the say miss
in the same way, and the compose result shows that line.

**A resource can serialize what `compose` runs together.** `compose`
starts the calls. The resource behind a tool decides whether their work
overlaps. The shipped workspace gives these results:

| Calls in one `Promise.all`              | Their work                    | Why                                                                              |
| --------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Tools outside the workspace             | Runs together, up to the cap  | No resource queue holds them.                                                    |
| `sql` and `sql`                         | Runs one call after the other | The SQLite handle runs one call at a time.                                       |
| `read`, `write`, `edit`, and `snapshot` | Runs one operation at a time  | The workspace queue runs one operation at a time ([Workspace](workspace.md)).    |
| `sql` and a file tool                   | Runs together                 | The database and the files have separate queues.                                 |
| The processes that `bash` starts        | Runs together                 | A process runs in the background, outside the queue ([Processes](processes.md)). |

**A tool call can hold several operations.** `snapshot` finds the files in
one operation and reads each file in another. Two calls of such a tool
interleave between their operations, and no two operations overlap.

**Processes carry parallel work in the workspace.** `bash` returns a handle
at once, and the process runs in the background. Code starts several
processes, then waits for each handle. The processes run together, so the
total wait is the time of the slowest one:

```js
// compose({ uses: ['bash', 'wait'], code })
const started = await Promise.all(
  suites.map((suite) => tools.bash({ command: `pnpm test ${suite}`, name: suite })),
);
const states = [];
for (const { process } of started) {
  // wait rejects when the process fails, and the error keeps the details.
  const ended = await tools.wait({ handles: [process.handle] }).catch((error) => error.details);
  states.push({ suite: process.name, state: ended.process.state, tail: ended.text.slice(-200) });
}
return states;
```

**One failed call rejects `Promise.all`, and its siblings keep running.**
`compose` does not cancel a sibling. `Promise.allSettled` gives the
outcome of each call, so code that wants every result uses it.

## How compose runs a nested call

**`compose` is a definition tool.** The executor options take a `compose`
option, beside `tools` and `bundles`. `describeExecutor` flattens the
tools, then appends `compose` and `describe` when the option is an object.
An absent option adds no tool, because the kernel imports no runtime.
The option takes no `false`, and `assertComposeOptions` refuses it. `pi()`,
`claude()`, and `codex()` fill an absent option with
`{ runtime: quickjsRuntime() }` once, when the agent is defined, so every
seat has both tools, and the tool list of a definition is the same in every
activation. The frozen executor keeps no `compose` field: the tool closes
over the option.

**The names `compose` and `describe` are reserved.** `appendTools` refuses a
tool of either name while it flattens the tools of the options, before the
two tools are appended. The check of the agent tools runs later, and its duplicate rule
refuses a second `compose`.

**Six files of the vocabulary layer hold the tools.** `compose.ts` holds
the types, the checks, and `COMPOSE_GUIDANCE`. `compose-tool.ts` holds the
tool and the hosting exports. `compose-run.ts` holds the run of one compose
call. `compose-catalog.ts` renders the catalog, `compose-describe.ts` holds the `describe` tool, and `compose-macros.ts`
checks the macros. `tool-call.ts` holds the one function that runs a tool
call. The file list of the layer in `biome.jsonc` names each file
([Toolchain](toolchain.md)).

**Every executor kind hosts `compose` as one more tool.** Pi builds its
tools from the definition. Claude and Codex host `pass.tools`, which holds
each tool of the definition as a `BoundTool`. The `invoke` of `compose`
closes over the other tools of the definition. It runs each nested call
through `tool-call.ts`, the one function that runs a tool call. A Codex
seat gets `compose` through the same `agentTools` path as a Claude seat,
and no test of `compose` runs on a Codex seat.

**`compose` runs each nested call as Pi runs a tool.** It takes these
actions in this order:

1. It checks that the name is in `uses`, and that the compose call is
   under its limits.
2. It applies `prepareArguments`, then checks the arguments against the
   input schema. A tool from `defineTool` checks them again inside
   `invoke`. The check of the core stands for every tool, because a tool
   built by hand can have an `invoke` that checks nothing. A direct call
   of Claude, Codex, or the scripted executor takes the same check. The
   check coerces nothing.
3. It gives the call a fresh call id and a `ToolContext`. The context
   copies the agent, the room, the activation, the exchange, the
   `deadline`, and the signal from the `compose` call. It sets
   `composeCall` to the call id of `compose`.
4. It calls `invoke`, and waits for the result.
5. It checks a declared output, and hands the binding value to the
   runtime.

**Pi coerces primitive arguments of a direct call, and `compose` does not.**
The Pi harness converts a primitive to the type that the schema names
before it checks the arguments. The text `"5"` becomes the number 5. The
arguments of the `compose` call pass through that conversion. The
arguments of a nested call pass through the check of the core alone. Code
must give the type that the schema states.

**A nested call keeps the deadline of the activation.** `wait` reads
`ctx.deadline` to end a wait before the room ends the activation
([Processes](processes.md)). A `wait` in a nested call reads the same
deadline.

**A nested call keeps its provenance.** Its `ToolContext` names the same
agent, room, activation, and exchange as the `compose` call. Its call id is
its own. A row that a nested call inserts carries the provenance of the
activation, as a direct call does.

**Each nested call records its steps.** The core records a `tool_call`
step and a `tool_result` step for each nested call, with a `parent` field
that holds the call id of `compose`. The core raises the tool events from
them, as it does for every tool. `ToolContext` has no `record`, so no tool
can write a step.

**Only the core hands the step sink to `compose`.** The hosting exports
`invokeTool` and `invokeChecked` do it
([Executors](executors.md#the-hosting-entry-exports)), and
[Pi](pi.md#tools-and-bundles-an-agent-can-add) states the Pi path. The
public `invoke` of `compose` holds no sink.
`runAgent` runs outside a room and has no sink, so a compose call there
records no nested step.

**`callId(tool)` skips a step with a `parent`.** A harness that cannot see
the id of a call takes the oldest `tool_call` step of that tool
([Executors](executors.md#the-room-tools)). A nested `bash` step must not
give its id to a direct `bash` call of the same batch. The record of
unclaimed calls skips a step with a `parent` too, so no harness can claim
it later.

**A nested step closes an open text block.** The trace closes an open
`text` or `thinking` block when any other step arrives. A nested step that
arrives while the model streams closes the block, as a direct tool step
does. The trace keeps the text. It keeps it in two blocks.

**Only the `compose` result reaches the model.** A nested result does not
call `delivered(call)`. When a nested room-tool call expects its result to
carry the record, the compose result carries it, and `delivered` of the
compose call counts the nested call as delivered. A nested result moves
`readThrough` only through that rule, or through the accepted say.

**A nested `terminate` does not end the activation.** The flag says that a
batch of the model has nothing more to do. The code is not a batch of the
model. `compose` ignores the flag, and its own result never sets it.

## Approval

**A harness hook does not see a nested call.** The room hosts `compose`,
and the harness sees it as one tool of the room server. The harness sees
neither the nested calls nor the `bash` that the code calls. A Claude seat
has no permission callback and no built-in tool, so no harness hook exists
to see them.

**The `compose` option takes an `approve` hook.** `compose` calls it with
a `ComposeRequest` and the `ToolContext` of the `compose` call. Free code
gives `{ uses, code }`. A macro gives `{ macro, hash, args }`: the name, the
blob hash of its file, and its checked arguments. The hook cannot record a
step. `compose` calls the hook after it checks `uses`, or the macro and its
`args`, and before it evaluates any code. The `approval` step records the
answer, with the call id of the `compose` call and `allow` or `deny`. A
denial fails the compose call with no ledger and no effect. A hook that
throws counts as a denial. With no hook, `compose` allows every compose call
of the catalog, and records no `approval` step.

```ts
interface ComposeOptions {
  readonly runtime: ComposeRuntime;
  readonly approve?: (
    request: ComposeRequest,
    ctx: ToolContext,
  ) => Promise<'allow' | 'deny'> | 'allow' | 'deny';
  /** Replaces `COMPOSE_GUIDANCE` ([Guidance](#guidance)). */
  readonly guidance?: string;
  /** Absent fields keep their defaults ([Limits](#limits)). */
  readonly limits?: Partial<ComposeLimits>;
}

type ComposeRequest =
  | { readonly uses: readonly string[]; readonly code: string }
  | { readonly macro: string; readonly hash: string; readonly args: JsonValue };

interface ComposeLimits {
  readonly calls: number;
  readonly concurrent: number;
  readonly bytes: number;
  readonly time: number;
}
```

## The runtime

**The runtime evaluates code against a set of bindings.** It holds no
tool, no room, and no `ToolContext`. `compose` gives it the code, the
names, one function to call a binding, and the abort signal.

```ts
interface ComposeRuntime {
  evaluate(input: ComposeRuntimeInput, signal: AbortSignal): Promise<JsonValue | undefined>;
}

interface ComposeRuntimeInput {
  readonly code: string;
  readonly bindings: readonly string[];
  /** The tools of the seat that the call does not bind. It sharpens the error for an unbound name. */
  readonly unlisted?: readonly string[];
  /** The checked arguments of a macro. Absent for free code. */
  readonly args?: JsonValue;
  /** Calls one binding. It resolves to the binding value, or rejects with `{ message, details? }`. */
  call(name: string, args: JsonValue): Promise<JsonValue>;
}
```

**The runtime gives code no ambient authority.** The global scope holds
`tools` and the ECMAScript built-ins, except those that read the clock or
a random source. The code of a macro also reads `args`, the JSON value
that `compose` checked. Free code has no `args`, and the name is
undefined there. There is no module import, no filesystem, no network, no
process, and no timer.

| Name                                          | In the code                                      |
| --------------------------------------------- | ------------------------------------------------ |
| `Date.now()`, `Date()`, `new Date()`          | Throws. A clock gives a value that no tool gave. |
| `new Date(value)`, `Date.UTC`, `Date.parse`   | Works. The value comes from the code or a tool.  |
| `Math.random`                                 | Throws.                                          |
| `WeakRef`, `FinalizationRegistry`             | Absent. Garbage collection sets their results.   |
| `Intl`, `performance`, `crypto`               | Absent.                                          |
| `setTimeout`, `setInterval`, `queueMicrotask` | Absent. `await` orders the work.                 |

**A tool gives the time.** Code that needs the current time calls a tool
that returns it. The ledger and the trace then hold the time that the code
read.

**The glue is deterministic.** Two runs that get the same binding values
make the same calls in the same order and return the same value. The
order of parallel calls that settle can differ between runs, so code that
depends on that order is not deterministic.

**Every value that crosses is JSON.** Arguments cross from the code to
`compose`, and binding values and errors cross back, as JSON. A runtime
can then run in the same process, in a separate process, or on a remote
host with one contract. A value that JSON cannot hold fails the call that
carries it.

**A runtime states its isolation.** A separate JavaScript context in
the same process limits the names that code reaches. It is not a security
boundary against hostile code. Each runtime states its memory limit, its
CPU limit, and its isolation. [Trust](trust.md) states what the kernel does
not defend.

**The runtime is separate from Codex Code Mode.** Codex Code Mode reads
host files outside the sandbox ([Codex](codex.md#the-trust-boundary)).
The Codex executor keeps it off in every seat. A Codex seat uses the `compose` tool,
as every seat does.

**A seat has `quickjsRuntime()` by default.** The executor options take a
`compose` option. With no option, the seat has the `compose` and `describe`
tools with `quickjsRuntime()`. A host passes its own `compose` object to
choose `processRuntime()`, an approval hook, guidance, or limits.

```ts
import { quickjsRuntime } from '@ambionframework/compose/runtime';

const analyst = defineAgent({
  name: 'analyst',
  identity: 'Reads the lab records.',
  executor: pi({
    instructions: 'Compose the lab tools when one result feeds another.',
    model: 'anthropic/claude-sonnet-5',
    bundles: [lab.tools()],
    compose: { runtime: quickjsRuntime(), limits: { calls: 32 } },
  }),
});
```

**The kernel imports no runtime.** An executor package imports the
default one from `@ambionframework/compose/runtime`, and `describeExecutor`
alone adds no tool for an absent option. A definition already holds the
`invoke` function of each tool, so it can hold a runtime. No journal
entry holds a definition, and `@ambionframework/cloudflare` finds each
definition by name in the worker, so no function crosses a wire.

**`@ambionframework/compose/runtime` holds the first two runtimes.** Both pass
one conformance suite, `composeRuntimeConformance`, which
`@ambionframework/ambion/conformance` exports beside the other suites of
the kernel.

| ComposeRuntime     | Runs the code                                           | Memory and CPU                                                                                                                                   | Isolation                                                                                                  |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `quickjsRuntime()` | In QuickJS compiled to WebAssembly, in the host process | A memory limit on the QuickJS heap (64 MiB), and a CPU limit on the time of the code (10,000 ms). A cut ends the run between stretches           | A fresh QuickJS runtime for each compose call. It shares the process of the host.                          |
| `processRuntime()` | In a `node:vm` context, in a child Node process         | `--max-old-space-size` on the old space of the child heap (64 MiB). An ArrayBuffer is outside that bound. The host kills the child at the signal | The child runs under `--permission` with no allow flag: no file, network, child process, worker, or addon. |

**`quickjsRuntime` uses the synchronous QuickJS build.** The asyncify
build of `quickjs-emscripten` runs one host call at a time, so
`Promise.all` would run its calls one after the other. The synchronous
build binds each tool as a host function that returns `ctx.newPromise()`.
The host settles that promise when the nested call settles, then runs
`runtime.executePendingJobs()`. Several nested calls then run together.
`setMemoryLimit` and a WebAssembly memory of its own bound the heap. The
CPU limit sums the time of the code over every stretch between two settled
calls, and the wait for a call does not count. The interrupt handler ends
code that runs past the limit. The host thread cannot see the signal while
code runs, so a cut takes effect between two stretches of code.
The runtime disposes each promise and each value handle that it makes.
QuickJS aborts the process when it frees a runtime that still holds one.
The package is MIT, it has no native part, and the lockfile already holds
it through `just-bash`.

**`processRuntime` needs the network permission of Node.** Node 22 has
no `--allow-net`, so its permission model does not refuse the network.
`processRuntime()` throws at construction on a Node whose
`process.allowedNodeEnvironmentFlags` has no `--allow-net`. The package
keeps the floor of Node 22.19, and `quickjsRuntime` runs on every
supported Node.

**The child of `processRuntime` speaks JSON lines over stdio.** Each
binding call carries an id, so several calls run together, and each
answer names the call that it settles. The child entry is one file.
Under `--permission` with no allow flag, Node loads the entry and refuses
every other file read, so a relative import fails with
`ERR_ACCESS_DENIED`. The package builds the child entry as its own tsdown
entry, and the entry imports only `node:` built-ins.
`packages/claude/tsdown.config.ts` builds two entries in the same way.

**Cloudflare has no compose runtime in the first version.** A worker cannot
start a process, and a worker loads WebAssembly only from its bundle. The
import of `quickjsRuntime` works in workerd, and an evaluation fails
there. `quickjsRuntime` catches the failure to load the module and throws
an error. The error says that QuickJS could not load its WebAssembly in this
runtime, and that a host passes `compose: { runtime }` with a compose
runtime that this host can run. A worker seat has `compose` and `describe`, and
`configure` of `@ambionframework/cloudflare` accepts it. A compose call fails
with that error until a compose runtime for workerd exists. `describe` works.

## Failure, cancellation, and effects

**A compose call is not a transaction.** A failure or a cancellation
undoes no completed call. The ledger states which calls completed.
`compose` never retries a call. The code can catch the error of a binding
and decide what to do.

**The first uncaught error fails the compose call.** The error names the
failure and the call that raised it. `compose` refuses further calls.

**`compose` answers after every call settles, on a normal end.** A call
can still run when the code ends, such as a sibling of a failed call in
`Promise.all`. `compose` waits for each such call to settle before it
answers. So the ledger holds the outcome of every call, and no effect runs
after the model reads the result.

**A call that outlives the code keeps the result.** Code can return while
a call it started still runs, such as a sibling of a rejected
`Promise.all` in the partial-result pattern. `compose` waits for that
call, records it in the ledger, and completes with the returned value.
The content names each such call and its outcome.

**`pending` marks a call that did not settle.** Only a cut or the limit
`compose.limits.time` can end a compose call before a call settles. The
ledger marks that call `pending`, and its effect can still happen.

**The cut cancels the compose call.** `compose` passes the signal of the
activation to the runtime and to each nested call. It starts no queued
call after the cut. A call that has started can complete its effect. The
error has the status `cancelled`.

**A retried activation runs its compose calls again.** The room does not
run an effect once
([Durability](durability.md#5-what-the-room-does-not-promise)). A new
attempt gives each nested call a fresh id, so a compose call is not a key
for an effect. A tool that must write once needs its own key, such as a
UNIQUE constraint on a table.

## Limits

**The limits live on the `compose` option.** A definition tool reaches no
limit of the runtime: `limits` goes to the executions, and the context of
a tool call carries none. So `compose` reads its limits from its own
option. An absent field keeps the default.

[Limits and fold cost](limits.md#the-limits-of-a-compose-call) names the four fields,
what each bounds, and its default.

**The time limit ends at the earlier bound.** `compose` stops the code at
`compose.limits.time` from its start, or at `ctx.deadline`, whichever
comes first.

**A compose call that passes a limit fails.** `compose` never cuts a
return value to fit. The error names the limit, so the code can return a
smaller value.

**The `calls` limit rejects the binding, so code can catch it.** The call
past the limit gets no id, no ledger entry, and no step. Its binding
rejects with an error that names `compose.limits.calls`. Arguments that
break the schema reject in the same way. Code that catches the error can
return what it has. The other limits end the compose call.

**The time limit covers the drain of late calls.** The timer starts before
the code and stops after every call settles. It can fire while `compose`
waits for a call that outlived the code. The compose call then fails with
the status `failed`, and the ledger marks each call that has not settled
`pending`.

**The trace caps bound what a nested call leaves.** Each nested call
records two steps, and they count against `limits.trace.stepsPerPass`.
Each output counts against `limits.trace.toolOutputBytes`
([Limits and fold cost](limits.md#the-limits)). The trace can cut a nested output.

## Acceptance

**The scripted executor runs the acceptance.** It gives a tool call a
signal and the deadline. It hands the step sink to `compose` through
`invokeTool`, so `settled(room)` waits for a deterministic compose call. A
test reads the nested steps. The scripted executor records the text of a
result, so a room test reads the status and the ledger from the rendered
content. A unit test of the `invoke` of `compose` reads the `ComposeResult`.
Items 1, 6, and 7 add a live run.

1. **The tools compose unchanged.** Each of Pi, Claude, and Codex hosts
   `compose` as one more definition tool. A workspace test binds `sql` and
   `snapshot` through `invokeTool`, and a macro test runs them on the
   scripted executor. A Pi seat on a scripted stream and a Claude seat on a
   fake executable run `compose` over a test tool. Each nested call keeps its
   preparation, its checks, its provenance, its deadline, and its steps.
2. **The data stays out of the context.** A test passes a large result
   from one tool into another. The model receives only the returned value,
   and the trace holds the nested calls with their `parent`.
3. **Two runtimes run the same code.** `quickjsRuntime()` and
   `processRuntime()` pass `composeRuntimeConformance`, with no change to a
   tool. The suite covers the globals table, a memory limit, a cut,
   concurrent binding calls, and JSON at each crossing.
4. **Failure keeps its facts.** An error, a cut, a limit, a denial, an
   invalid declared output, and a call that outlives the code each give
   the stated status and ledger. No nested call counts as delivered to the
   model, and no nested step gives its id to a direct call.
5. **Parallel calls keep their facts.** Code that starts more calls than
   `compose.limits.concurrent` runs the cap at a time. A `sequential` tool
   runs one call at a time. A failed call in `Promise.all` leaves its
   siblings to settle, and the ledger holds the outcome of each.
6. **Processes carry parallel work.** A compose call starts several
   processes with `bash` and waits for each. The wall time stays near the
   time of the slowest process. Only the live run measures the wall time.
7. **The guidance steers the choice.** The live comparison holds two cases
   on each executor kind. In the first, the result of one tool feeds
   another, and the seat calls `compose`. In the second, the seat must
   read a result before it decides, and the result decides what it does.
   Code that branches on the result is a valid compose call too. So the
   run records whether the seat called the tool directly. In the live run,
   the second case passed on each kind. With the earlier guidance, the
   first case failed on each kind: the seat called `sql` and `snapshot`
   directly. With the current guidance, the first case passed on Codex at
   the efforts medium and high. It failed on Pi and Claude with
   `claude-sonnet-5`. A later run passed on Pi and failed on Claude, so
   the choice of `claude-sonnet-5` changes from run to run. A fan-out
   case reads many logs and snapshots a few. With `compose`, the seat
   cost more input tokens on Pi and Claude, because it made many direct
   calls before it composed. Codex failed the fan-out case with and
   without `compose`: it omitted a filter of the task.
