# Compose

**Status: proposed design.** No package exports these interfaces yet.
[The 0.6.0 plan](../planning/0.6.0.md) holds the work.

**The `compose` tool joins the tools of a seat into one call.** The agent
calls `compose` with the tools that it uses and short code. The code passes
the result of one tool into the next, and returns one value to the model.
The data between the calls never enters the context of the model, so it
costs no inference tokens.

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

| Term         | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| compose call | One call of the `compose` tool, and the run of the code that it carries.        |
| nested call  | One call of a tool that the code of a compose call makes.                       |
| binding      | One tool as an asynchronous function inside the code: `tools.<name>`.           |
| catalog      | The signatures of the tools that a seat can bind, in the `compose` description. |
| evaluator    | The pluggable backend that evaluates the code. It holds no tool.                |
| ledger       | The nested calls of one compose call, in order, with the outcome of each.       |

## The compose tool

**`compose` takes two arguments.**

```ts
interface ComposeArguments {
  /** The tools this compose call uses. Only these are bound. */
  readonly uses: readonly string[];
  /** The body of an asynchronous function. Its return value is the result. */
  readonly code: string;
}
```

**`uses` declares the tools before the code runs.** `compose` refuses a
name that the catalog does not hold. It checks `uses` first, then asks
the [approval](#approval), then evaluates the code. A refusal at either
step has no ledger and no effect. `compose` binds only the named tools,
so a call to another tool fails as an unknown binding.

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

**A failed or cancelled compose call throws.** Its message renders the
error and the ledger. Every family marks a thrown error as a tool error:
Claude and Codex give its message as an error result, and Pi does the
same. The model then knows which calls completed and which effects can
stand. The error is a `ToolFailure` whose `details` hold the `ComposeResult`. The ledger never holds the
input or the output of a call.

**The content is the contract.** Claude and Codex host a definition tool as
a `RoomTool`, and a `RoomTool` keeps the content alone
([Executors](executors.md#the-room-tools)). The `ComposeResult` in
`details` reaches a Pi seat and its trace. On Claude and Codex, the model
and the trace read the rendered content.

## The catalog

**The `compose` tool describes its bindings as TypeScript.** The core
renders one signature for each tool that the seat can bind. It reads the
input schema, the description, and the declared output of the tool. The
catalog is part of the description of `compose`, so the model reads it
once for each activation.

```ts
declare const tools: {
  /** Run statements on the shared database. */
  sql(args: { sql: string; export?: string; import?: string; rows?: number }): Promise<{
    database: string;
    count: number;
    columns: string[];
    rows: Record<string, JsonValue>[];
    export?: string;
    import?: string;
    imported?: number;
  }>;
  /** Freeze files of the workspace and give one ref for each. */
  snapshot(args: { paths: string[] }): Promise<{ refs: string[] }>;
  /** Fetch an order by id. */
  lookup_order(args: { id: string }): Promise<string>;
};
```

**The renderer covers the JSON Schema that TypeBox writes.** An object, an
array, a union, a literal, and the primitive types each have a TypeScript
form. A schema with no form renders as `unknown`. The input schema stays
the authority: `compose` checks every argument against it.

**The catalog costs input tokens.** The model already reads the schema of
each tool as a native tool. The catalog repeats each input schema, and
adds each declared output. A seat with many tools pays that cost in every
activation. The live comparison of CP6 counts the catalog in the input
tokens of the seat.

## Guidance

**The model decides when to compose.** The name of the tool gives little
of that decision. The guidance gives the rest. It states when a compose
call helps, and when a direct call is the right call.

**`compose` adds guidance, as a bundle does.** `describeExecutor` joins
the guidance of `compose` after the guidance of the bundles, in the
`guidance` field of the executor. The prompt renders it after the speaking
policy, as it renders the guidance of every bundle
([Executors](executors.md#the-prompt-the-core-renders)). The description of
`compose` holds one sentence and the catalog.

**The text is `COMPOSE_GUIDANCE`.** `compose.ts` holds it, and the main
entry exports it. `ComposeOptions.guidance` replaces it, as the `speaking`
option replaces `DEFAULT_GUIDANCE`. The text follows:

```text
compose joins your tools in one call. Put the tools that you use in
uses, and the body of an async function in code. Each tool is
tools.<name>, and the description of compose gives its signature. You
read only the value that the code returns.

Use compose when:
- the result of one tool is the input of another tool;
- a tool gives a large result, and you need a count, a filter, or a
  few fields of it;
- you call one tool for many inputs;
- you start several processes and wait for each.

Call a tool directly when:
- you must read its result before you decide the next step;
- you make one call and need its whole result;
- you speak. say, schedule, seat, unseat, dismiss, and recall are not
  in compose.

Return only the values that you need to read. The code has no clock,
no random source, and no I/O except through tools. A failed compose
call lists each call and its outcome. A completed call can have had an
effect, so read the list before you call a tool again.
```

**The description of `compose` is one sentence and the catalog.** The
sentence is `Join your tools in one call. Code calls them as
tools.<name>, and you read only the value that it returns.` The catalog
follows it.

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
catalog states which one. `details` with no declared schema has no
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
error crosses to the evaluator as the JSON `{ message, details? }`, and
the evaluator builds the `Error` from it.

**A tool learns that a compose call called it from `ctx`.**
`ToolContext.composeCall` holds the id of the `compose` call. It is absent
for a direct call. `compose` sets it, and code cannot set it. The field
changes no permission and no effect.

```ts
interface ToolContext {
  // The existing fields stay the same.
  readonly composeCall?: string;
}
```

**The shipped tools declare their outputs in the same change.** Today
`sql` keeps the rows in its text preview, and its `details` hold only the
count of rows. The other tools below already return structured `details`,
and each gains a schema for them:

| Tool       | Declared output                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `sql`      | The database, the count of every row, the columns, the preview rows, and the export or import facts. |
| `snapshot` | The refs, one for each path, in order.                                                               |
| `bash`     | The process, with its handle and its state, and the output read.                                     |
| `ps`       | The processes, with the handle and the state of each.                                                |
| `wait`     | The processes, and the processes that ended.                                                         |
| `fork`     | The repository that the fork made, when the fork made one.                                           |

**`sql` gives the rows that it already reads.** The preview holds the rows
up to the limit `rows`, so the declared output needs no second query.
`count` is the count of every row of the result, which `details.rows`
holds today. `rows` becomes the preview rows. A row value is JSON: text,
a number, or null. A blob is its bytes as lowercase hex, as the CSV export
writes it. A `bigint` is its decimal digits as text.

## Typing a declared output

**`defineTool` ties the return type of `execute` to the declared output.**
With `compose: { output: O }`, `execute` must return a `ToolResult` whose
`details` is `Static<O>`. A string, a missing field, or a value of the
wrong type fails `tsc`. The runtime check of each call stays, because a
tool built by hand as an `AmbionTool` gets no help from the compiler.

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

**`ToolResult` takes the type of its details.** `ToolResult<TDetails =
unknown>` keeps its current shape when no type is given. `AmbionTool`
keeps `details` as `unknown`, because a list of tools holds tools of many
outputs.

**`defineTool` has two overloads.** The overload for a declared output
comes last, so the compiler reports its error, and that error names the
field that breaks the schema, such as `Property 'status' is missing`.

```ts
interface DeclaredToolOptions<P extends TSchema, O extends TSchema> extends BaseToolOptions<P> {
  compose: { readonly output: O };
  execute: (
    params: Static<P>,
    ctx: ToolContext,
  ) => Promise<ToolResult<Static<O>>> | ToolResult<Static<O>>;
}

interface PlainToolOptions<P extends TSchema> extends BaseToolOptions<P> {
  compose?: false;
  execute: (
    params: Static<P>,
    ctx: ToolContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
}

function defineTool<P extends TSchema>(options: PlainToolOptions<P>): AmbionTool;
function defineTool<P extends TSchema, O extends TSchema>(
  options: DeclaredToolOptions<P, O>,
): AmbionTool;
```

`BaseToolOptions` holds the fields that `DefineToolOptions` holds today,
except `execute`. A `tsc` run over this sketch accepts a matching `details`
and a string from an undeclared tool. It refuses a string, a wrong literal,
and a missing field from a declared tool.

**Existing callers keep compiling.** `fromPiTool` calls
`defineTool<TSchema>` with one type argument, so only the first overload
applies. `recordedOnShell` returns a pi-agent-core `AgentToolResult<D>`,
and its content parts fit `ToolResult<Static<O>>`.

**The schema is the one source of the type.** A workspace tool derives its
details type from its output schema, as `type SnapshotDetails =
Static<typeof SnapshotOutput>`. The interface and the schema then cannot
drift. `SqlDetails`, `SnapshotDetails`, `ProcessDetails`, `PsDetails`,
`WaitDetails`, and `ForkDetails` each become such a type.

**Two details need care.** `ProcessDetails.truncation` holds the
pi-agent-core type `ShellOutputTruncation`. Its schema lists the fields of
that type, and a type test pins that the two stay assignable. A `Static`
type holds mutable arrays, so a tool copies a readonly array into its
details, as `wait` already does with `[...processes]`.

**`fromPiTool` takes the same declaration.** A second argument,
`{ output: O }`, requires the `TDetails` of the Pi `AgentTool` to be
`Static<O>`, and passes the declaration to `defineTool`.

## What a compose call binds

**A compose call binds the tools of the definition.** It binds each tool
that the definition holds after it flattens `tools` and `bundles`, and
omits each tool that sets `compose: false`. `compose` builds the catalog
once, when the definition is made.

**The room tools do not bind.** They are bound to the activation, and a
definition tool cannot reach them. `say`, `schedule`, `seat`, `unseat`,
and `dismiss` commit an entry. A say carries the read position of the
activation, and the room can answer `missed` with new messages that the
model must read. A compose call computes a value, and the agent decides
what to say about it.

**Code reads the record through the workspace mirror.** `recall` is a
room tool, so it does not bind. A workspace mirror writes the messages of
a room to `/rooms/<name>/messages.jsonl`
([Workspace](workspace.md#mirror-a-rooms-messages)). Code reads that file
through its bindings.

**`compose` does not bind itself.** A compose call cannot start a compose
call.

**A closing activation has no `compose`.** It receives only `say`, as
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
  states.push({ suite: process.name, state: ended.processes[0].state });
}
return states;
```

**One failed call rejects `Promise.all`, and its siblings keep running.**
`compose` does not cancel a sibling. `Promise.allSettled` gives the
outcome of each call, so code that wants every result uses it.

## How compose runs a nested call

**`compose` is a definition tool.** The executor options take a `compose`
option, beside `tools` and `bundles`. `describeExecutor` flattens the
tools, then appends `compose` when the option is present. `pi()`,
`claude()`, and `codex()` each call `describeExecutor`, so every family
gets the tool the same way. The frozen executor keeps no `compose` field:
the tool closes over the option.

**The name `compose` is reserved.** `appendTools` refuses a tool of that
name while it flattens the tools of the options, before `compose` is
appended. The check of the agent tools runs later, and its duplicate rule
refuses a second `compose`.

**The code of the tool lives in `packages/ambion/src/compose.ts`.** It
uses the TypeBox checks and the step vocabulary, as `define.ts` does, so
it joins the vocabulary layer. The file list of that layer in
`biome.jsonc` gains it ([Toolchain](toolchain.md)).

**Every family hosts `compose` as one more tool.** Pi builds its tools
from the definition. Claude and Codex host `pass.tools`, which holds each
tool of the definition as a `RoomTool`. The `invoke` of `compose` closes
over the other tools of the definition, and calls each `AmbionTool`
directly.

**`compose` runs each nested call as Pi runs a tool.** It takes these
actions in this order:

1. It checks that the name is in `uses`, and that the compose call is
   under its limits.
2. It applies `prepareArguments`, then checks the arguments against the
   input schema. A tool from `defineTool` checks them again inside
   `invoke`. `compose` keeps its own check, because a tool built by hand
   can have an `invoke` that checks nothing.
3. It gives the call a fresh call id and a `ToolContext`. The context
   copies the agent, the room, the activation, the exchange, the
   `deadline`, and the signal from the `compose` call. It sets
   `composeCall` to the call id of `compose`.
4. It calls `invoke`, and waits for the result.
5. It checks a declared output, and hands the binding value to the
   evaluator.

**A nested call keeps the deadline of the activation.** `wait` reads
`ctx.deadline` to end a wait before the room ends the activation
([Processes](processes.md)). A `wait` in a nested call reads the same
deadline.

**A nested call keeps its provenance.** Its `ToolContext` names the same
agent, room, activation, and exchange as the `compose` call. Its call id is
its own. A row that a nested call inserts carries the provenance of the
activation, as a direct call does.

**Each nested call records its steps.** `ToolContext` gains
`record(step)`. `compose` records a `tool_call` step and a `tool_result`
step for each nested call, with a `parent` field that holds the call id of
`compose`. The core raises the tool events from them, as it does for every
tool.

**Each family supplies `record`.** The hosting export `toolContext` takes
the step sink of the activation. The core passes it for Claude and Codex.
`@ambionframework/pi` builds the context of each call itself, so it passes
`activation.trace` through `toolsFor`. `runAgent` runs outside a room and
has no sink, so a compose call there records no nested step.

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
call `delivered(call)`, and it does not move `readThrough`. The model read
the `compose` result alone.

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
`uses`, `code`, and the `ToolContext` of the `compose` call, without
`record`. It calls the hook after it checks `uses` and before it evaluates
any code. The step that records the answer is part of this proposal. The
step vocabulary has no such kind today. A denial fails the
compose call with no ledger and no effect. With no hook, `compose` allows
every compose call of the catalog.

```ts
interface ComposeOptions {
  readonly evaluator: Evaluator;
  readonly approve?: (
    request: { readonly uses: readonly string[]; readonly code: string },
    ctx: Omit<ToolContext, 'record'>,
  ) => Promise<'allow' | 'deny'> | 'allow' | 'deny';
  /** Replaces `COMPOSE_GUIDANCE` ([Guidance](#guidance)). */
  readonly guidance?: string;
  /** Absent fields keep their defaults ([Limits](#limits)). */
  readonly limits?: Partial<ComposeLimits>;
}

interface ComposeLimits {
  readonly calls: number;
  readonly concurrent: number;
  readonly bytes: number;
  readonly time: number;
}
```

## The evaluator

**The evaluator evaluates code against a set of bindings.** It holds no
tool, no room, and no `ToolContext`. `compose` gives it the code, the
names, one function to call a binding, and the abort signal.

```ts
interface Evaluator {
  evaluate(input: EvaluatorInput, signal: AbortSignal): Promise<JsonValue | undefined>;
}

interface EvaluatorInput {
  readonly code: string;
  readonly bindings: readonly string[];
  /** Calls one binding. It resolves to the binding value, or rejects with `{ message, details? }`. */
  call(name: string, args: JsonValue): Promise<JsonValue>;
}
```

**The evaluator gives code no ambient authority.** The global scope holds
`tools` and the ECMAScript built-ins, except those that read the clock or
a random source. There is no module import, no filesystem, no network, no
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
`compose`, and binding values and errors cross back, as JSON. An evaluator
can then run in the same process, in a separate process, or on a remote
host with one contract. A value that JSON cannot hold fails the call that
carries it.

**An evaluator states its isolation.** A separate JavaScript context in
the same process limits the names that code reaches. It is not a security
boundary against hostile code. Each evaluator states its memory limit, its
CPU limit, and its isolation. [Trust](trust.md) states what the kernel does
not defend.

**The evaluator is separate from Codex Code Mode.** Codex Code Mode reads
host files outside the sandbox ([Codex](codex.md#the-trust-boundary)).
`nativeTools: 'none'` keeps it off. A Codex seat uses the `compose` tool,
as every seat does.

**A seat opts in with an evaluator.** The executor options take a
`compose` option. With no option, the seat has no `compose` tool.

```ts
import { quickjsEvaluator } from '@ambionframework/evaluator';

const analyst = defineAgent({
  name: 'analyst',
  identity: 'Reads the lab records.',
  executor: pi({
    instructions: 'Compose the lab tools when one result feeds another.',
    model: 'anthropic/claude-sonnet-5',
    bundles: [lab.tools()],
    compose: { evaluator: quickjsEvaluator(), limits: { calls: 32 } },
  }),
});
```

**The kernel imports no evaluator.** An evaluator package provides one, as
an executor package provides an execution. A definition already holds the
`invoke` function of each tool, so it can hold an evaluator. No journal
entry holds a definition, and `@ambionframework/cloudflare` finds each
definition by name in the worker, so no function crosses a wire.

**`@ambionframework/evaluator` holds the first two evaluators.** Both pass
one conformance suite, `evaluatorConformance`, which
`@ambionframework/ambion/conformance` exports beside the other suites of
the kernel.

| Evaluator            | Runs the code                                           | Memory and CPU                                                         | Isolation                                                                                                  |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `quickjsEvaluator()` | In QuickJS compiled to WebAssembly, in the host process | A memory limit on the QuickJS heap. An interrupt handler at the signal | A fresh QuickJS runtime for each compose call. It shares the process of the host.                          |
| `processEvaluator()` | In a `node:vm` context, in a child Node process         | `--max-old-space-size` on the child. The host kills it at the signal   | The child runs under `--permission` with no allow flag: no file, network, child process, worker, or addon. |

**`quickjsEvaluator` uses the synchronous QuickJS build.** The asyncify
build of `quickjs-emscripten` runs one host call at a time, so
`Promise.all` would run its calls one after the other. The synchronous
build binds each tool as a host function that returns `ctx.newPromise()`.
The host settles that promise when the nested call settles, then runs
`runtime.executePendingJobs()`. Several nested calls then run together.
`setMemoryLimit` and `setInterruptHandler` give the limits in the table.
The evaluator disposes each promise and each value handle that it makes.
QuickJS aborts the process when it frees a runtime that still holds one.
The package is MIT, it has no native part, and the lockfile already holds
it through `just-bash`.

**`processEvaluator` needs the network permission of Node.** Node 22 has
no `--allow-net`, so its permission model does not refuse the network.
`processEvaluator()` throws at construction on a Node whose
`process.allowedNodeEnvironmentFlags` has no `--allow-net`. The package
keeps the floor of Node 22.19, and `quickjsEvaluator` runs on every
supported Node.

**The child of `processEvaluator` speaks JSON lines over stdio.** Each
binding call carries an id, so several calls run together, and each
answer names the call that it settles. The child entry is one file.
Under `--permission` with no allow flag, Node loads the entry and refuses
every other file read, so a relative import fails with
`ERR_ACCESS_DENIED`. The package builds the child entry as its own tsdown
entry, and the entry imports only `node:` built-ins.
`packages/claude/tsdown.config.ts` builds two entries in the same way.

**Cloudflare has no evaluator in the first version.** A worker cannot
start a process, and a worker loads WebAssembly only from its bundle. A
seat on `@ambionframework/cloudflare` has no `compose` option until an
evaluator for workerd exists.

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
activation to the evaluator and to each nested call. It starts no queued
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

| Limit                       | What it bounds                                       | Default    |
| --------------------------- | ---------------------------------------------------- | ---------- |
| `compose.limits.calls`      | Nested calls in one compose call                     | 64         |
| `compose.limits.concurrent` | Nested calls that run at the same time               | 8          |
| `compose.limits.bytes`      | UTF-8 bytes of the encoded return value              | 65,536     |
| `compose.limits.time`       | Wall time of one compose call, within `ctx.deadline` | 120,000 ms |

**The time limit ends at the earlier bound.** `compose` stops the code at
`compose.limits.time` from its start, or at `ctx.deadline`, whichever
comes first.

**A compose call that passes a limit fails.** `compose` never cuts a
return value to fit. The error names the limit, so the code can return a
smaller value.

**The trace caps bound what a nested call leaves.** Each nested call
records two steps, and they count against `limits.trace.stepsPerPass`.
Each output counts against `limits.trace.toolOutputBytes`. The default of
64 calls keeps one compose call at 128 steps of the 1,000 of a pass. The
trace can cut a nested output.

## Changes to other contracts

**The implementation updates these pages in the same change.** Until then,
each page states the current surface.

| Page                                                                   | Change                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Definitions and tools](agent.md)                                      | The `compose` option, the `compose` field of a tool, the two overloads of `defineTool`, and `ToolResult<TDetails>`.                                                                                                                                                                      |
| [Executors](executors.md)                                              | `parent` on `tool_call` and `tool_result`, `record` in `toolContext`, `callId`.                                                                                                                                                                                                          |
| [Trust](trust.md)                                                      | A harness sees one tool for a compose call, and no nested call. `approve` is the one hook that sees one.                                                                                                                                                                                 |
| [Workspace](workspace.md)                                              | The declared outputs of `sql`, `snapshot`, `bash`, `ps`, `wait`, and `fork`, and `count` in the `sql` details.                                                                                                                                                                           |
| [Envelope](envelope.md)                                                | The four limits of the `compose` option and their defaults.                                                                                                                                                                                                                              |
| [Pi](pi.md)                                                            | `toolsFor` passes the step sink of the activation to each call. `fromPiTool` takes an output declaration.                                                                                                                                                                                |
| [Technical facts](technical-facts.md) and [Toolchain](toolchain.md)    | The package `@ambionframework/evaluator`, and the count of packages.                                                                                                                                                                                                                     |
| `biome.jsonc` and `scripts/import-rules.test.mjs`                      | `compose.ts` joins the vocabulary layer. `packages/evaluator/src` may import `@ambionframework/ambion`, and not `/testing` or the source of the core.                                                                                                                                    |
| [Executors](executors.md#the-room-tools) and [Toolchain](toolchain.md) | The scripted executor of `/testing` gives each tool call a signal, the deadline, and a step sink.                                                                                                                                                                                        |
| Export entries and snapshot                                            | The main entry exports the types `Evaluator`, `EvaluatorInput`, `ComposeOptions`, `ComposeLimits`, `ComposeResult`, and `LedgerEntry`, and the value `COMPOSE_GUIDANCE`. The snapshot lists values only, so `COMPOSE_GUIDANCE` and `evaluatorConformance` from `/conformance` change it. |
| Changelog                                                              | The step vocabulary, `ToolContext`, `AmbionTool`, `defineTool`, and the `sql` details: `rows` becomes `count`.                                                                                                                                                                           |

## Acceptance

**The scripted executor runs the acceptance.** Today it gives a tool call
no signal, no deadline, and no step sink. The same change gives it all
three, so `settled(room)` waits for a deterministic compose call, and a
test reads the nested steps. The scripted executor records the text of a
result, so a room test reads the status and the ledger from the rendered
content. A unit test of the `invoke` of `compose` reads the
`ComposeResult`. Items 1 and 6 also run on the live tier of each family
once.

1. **The tools compose unchanged.** A seat on each of Pi, Claude, and Codex
   binds `sql` and `snapshot` with the same code. Each nested call keeps
   its preparation, its checks, its provenance, its deadline, and its
   steps.
2. **The data stays out of the context.** A test passes a large result
   from one tool into another. The model receives only the returned value,
   and the trace holds the nested calls with their `parent`.
3. **Two evaluators run the same code.** `quickjsEvaluator()` and
   `processEvaluator()` pass `evaluatorConformance`, with no change to a
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
   time of the slowest process.
7. **The guidance steers the choice.** The live comparison of CP6 holds
   two cases on each family. In the first, the result of one tool feeds
   another, and the seat calls `compose`. In the second, the seat must
   read a result before it decides, and it calls the tool directly.
