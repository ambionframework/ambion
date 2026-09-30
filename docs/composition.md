# Composition

**Status: proposed design.** No package exports these interfaces yet.
[The backlog](../planning/backlog.md) holds the work as D24.

**A composition joins the tools of a seat into one call.** The agent calls
`compose` with the tools that it uses and short code. The code passes the
result of one tool into the next, and returns one value to the model. The
data between the calls never enters the context of the model, so it costs
no inference tokens.

```js
// compose({ uses: ['sql', 'snapshot'], code })
const drift = await tools.sql({ sql: "SELECT path FROM runs WHERE label = 'drift'" });
const { refs } = await tools.snapshot({ paths: drift.rows.map((row) => row.path) });
return { runs: drift.rows.length, refs };
```

**The model reads the returned value alone.** Here that is a count and the
snapshot refs. The rows and the paths stay in the composition. The agent
then cites the refs in a `say`, as it does today.

**The tools stay the same tools.** Each call inside a composition runs the
ordinary tool, with its schema, its checks, its authority, and its
provenance. A tool needs no change to compose. A tool can declare the shape
of its result, so that code and the model can depend on it.

**Code is the glue between tools.** It reaches the world through its
bindings alone. It has no clock, no random source, no timer, no import,
and no I/O. A composition is a function of the values that its tools
return.

## Terms

| Term        | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| composition | One run of the code that one `compose` call carries.                          |
| binding     | One tool as an asynchronous function inside a composition: `tools.<name>`.    |
| catalog     | The signatures of the tools that a seat can compose, in the `compose` tool.   |
| composer    | The `compose` tool itself: it checks, approves, dispatches, and records.      |
| evaluator   | The pluggable backend that evaluates the code. It holds no tool.              |
| ledger      | The calls that one composition made, in order, with the outcome of each call. |

## The compose tool

**`compose` takes two arguments.**

```ts
interface ComposeArguments {
  /** The tools this composition calls. Only these are bound. */
  readonly uses: readonly string[];
  /** The body of an asynchronous function. Its return value is the result. */
  readonly code: string;
}
```

**`uses` declares the tools before the code runs.** The composer refuses a
name that the catalog does not hold before it evaluates any code. That
refusal has no ledger and no effect. The composer binds only the named
tools, so a call to another tool fails as an unknown binding. The
[approval](#approval) decides on `uses` and `code` together, once for the
composition.

**`code` is a function body.** It runs as the body of an `async` function
with fresh local state. `await` works at the top level. `return` gives the
result. A body with no `return` gives `undefined`, and the model reads that
the composition completed with no value.

**The returned value must be JSON.** The composer encodes it and renders it
for the model. A value that JSON cannot hold, such as a function or a
cycle, fails the composition with an error that names the problem.

**Code that wants a partial result catches the error.** A composition
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

**The result keeps the shape of every tool result.** `content` holds the
text that the model reads. `details` holds a `CompositionResult`:

```ts
interface CompositionResult {
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

**The content renders the value on success.** On failure or cancellation,
the content renders the error and the ledger. The model then knows which
calls completed and which effects can stand. The ledger names each call
and its outcome. It never holds the input or the output of a call.

**The content is the contract.** Claude and Codex host a definition tool as
a `RoomTool`, and a `RoomTool` keeps the content alone
([Executors](executors.md#the-room-tools)). The `CompositionResult` in
`details` reaches a Pi seat and its trace. On Claude and Codex, the model
and the trace read the rendered content.

## The catalog

**The `compose` tool describes its bindings as TypeScript.** The core
renders one signature for each tool that the seat can compose. It reads
the input schema, the description, and the declared output of the tool.
The catalog is part of the description of `compose`, so the model reads it
once for each activation.

```ts
declare const tools: {
  /** Run statements on the shared database. */
  sql(args: { sql: string; export?: string; import?: string; rows?: number }): Promise<{
    database: string;
    columns: string[];
    rows: Record<string, JsonValue>[];
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
the authority: the composer checks every argument against it.

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
| `{ output: schema }` | Returns `details`, after the composer checks it against `schema`.    |
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
a composition.

**A declared output is checked at every call.** An invalid `details`
rejects the binding with an error. The error names the tool, the call, the
paths that break the schema, and the fact that the call completed. The
check undoes no effect and authorizes no retry. The ledger marks the call
`completed`, and the composition fails at that point unless the code
catches the error.

**A failed call rejects its binding with an `Error`.** The error carries
the message that the model reads for a direct call. A workspace tool
throws a `ToolFailure` with `details`, such as the exit status of a
process that `wait` saw fail. The binding copies those `details` to
`error.details` as JSON, so the code reads the status without parsing
text.

**A tool learns that a composition called it from `ctx`.**
`ToolContext.composition` holds the id of the `compose` call. It is absent
for a direct call. The composer sets it, and code cannot set it. The field
changes no permission and no effect.

```ts
interface ToolContext {
  // The existing fields stay the same.
  readonly composition?: string;
}
```

**The shipped tools declare their outputs in the same change.** Today
`sql` keeps the rows in its text preview, and its `details` hold only a
count. `ps` renders a table. A composition of an undeclared tool reads
text, so the change gives these tools an output schema:

| Tool       | Declared output                                                  |
| ---------- | ---------------------------------------------------------------- |
| `sql`      | The database, the columns, and the rows up to the limit `rows`.  |
| `snapshot` | The refs, one for each path, in order.                           |
| `bash`     | The process, with its handle and its state, and the output read. |
| `ps`       | The processes, with the handle and the state of each.            |
| `wait`     | The processes, and the processes that ended.                     |
| `fork`     | The repository that the fork made, when the fork made one.       |

**`sql` gives the rows that it already reads.** The preview of the result
holds the rows up to the limit `rows`, so the declared output needs no
second query. A row value is JSON: text, a number, or null. A blob is its
bytes as lowercase hex, as the CSV export writes it. A `bigint` is its
decimal digits as text.

## What composes

**A composition binds the tools of the definition.** It binds each tool
that the definition holds after it flattens `tools` and `bundles`, and
omits each tool that sets `compose: false`. The composer builds the catalog
once, when the definition is made.

**The room tools do not compose.** They are bound to the activation, and a
definition tool cannot reach them. `say`, `schedule`, `seat`, `unseat`,
and `dismiss` commit an entry. A say carries the read position of the
activation, and the room can answer `missed` with new messages that the
model must read. A composition computes a value, and the agent decides what
to say about it.

**Code reads the record through the workspace mirror.** `recall` is a
room tool, so it does not compose. A workspace mirror writes the messages
of a room to `/rooms/<name>/messages.jsonl`
([Workspace](workspace.md#mirror-a-rooms-messages)). Code reads that file
through its bindings.

**`compose` does not bind itself.** A composition cannot start a
composition.

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

**A tool with `executionMode: 'sequential'` runs one call at a time.** The
composer runs the calls of such a tool one after another, inside one
composition, in the order that the code makes them. Calls of other tools
still run beside them.

**A resource can serialize what the composer runs together.** The composer
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
The composer does not cancel a sibling. `Promise.allSettled` gives the
outcome of each call, so code that wants every result uses it.

## The composer

**`compose` is a definition tool.** The executor options take a
`compose` option, beside `tools` and `bundles`. `describeExecutor`
flattens the tools, then appends `compose` when the option is present.
`pi()`, `claude()`, and `codex()` each call `describeExecutor`, so every
family gets the tool the same way. The name `compose` is reserved.
`appendTools` refuses a tool of that name while it flattens the tools of
the options, before the composer appends its own. The check of the agent
tools runs later, and its duplicate rule refuses a second `compose`. The
frozen executor keeps no `compose` field: the tool closes over the option.

**The composer lives in `packages/ambion/src/compose.ts`.** It uses the
TypeBox checks and the step vocabulary, as `define.ts` does, so it joins
the vocabulary layer. The file list of that layer in `biome.jsonc` gains
it ([Toolchain](toolchain.md)). Pi builds its tools from the definition. Claude and Codex host
`pass.agentTools`, which maps the same tools one to one. So each family
hosts `compose` as one more tool. Its `invoke` closes over the other tools
of the definition and calls each `AmbionTool` directly.

**The composer runs each call as Pi runs a tool.** It takes these actions
in this order:

1. It checks that the name is in `uses`, and that the composition is under
   its limits.
2. It applies `prepareArguments`, then checks the arguments against the
   input schema. A tool from `defineTool` checks them again inside
   `invoke`. The composer keeps its own check, because a tool built by hand
   can have an `invoke` that checks nothing.
3. It gives the call a fresh call id and a `ToolContext`. The context
   copies the agent, the room, the activation, the exchange, the
   `deadline`, and the signal from the `compose` call. It sets
   `composition` to the call id of `compose`.
4. It calls `invoke`, and waits for the result.
5. It checks a declared output, and hands the binding value to the
   evaluator.

**A nested call keeps the deadline of the activation.** `wait` reads
`ctx.deadline` to end a wait before the room ends the activation
([Processes](processes.md)). A `wait` inside a composition reads the same
deadline.

**A nested call keeps its provenance.** Its `ToolContext` names the same
agent, room, activation, and exchange as the `compose` call. Its call id is
its own. A row that a composition inserts carries the provenance of the
activation, as a direct call does.

**Each nested call records its steps.** `ToolContext` gains
`record(step)`. The composer records a `tool_call` step and a
`tool_result` step for each nested call, with a `parent` field that holds
the call id of `compose`. The core raises the tool events from them, as it
does for every tool.

**`record` is the one change to `ToolContext` for the trace.** The hosting export `toolContext`
takes the step sink of the activation. The core passes it for Claude and
Codex. `@ambionframework/pi` builds the context of each call itself, so it
passes `activation.trace` through `toolsFor`. `runAgent` runs outside a
room and has no sink, so a composition there records no nested step.

**`callId(tool)` skips a step with a `parent`.** A harness that cannot see
the id of a call takes the oldest `tool_call` step of that tool
([Executors](executors.md#the-room-tools)). A nested `bash` step must not
give its id to a direct `bash` call of the same batch. The record of
unclaimed calls skips a step with a `parent` too, so no harness can claim
it later.

**A nested step closes an open text block.** The trace closes an open
`text` or `thinking` block when any other step arrives. A nested step
that arrives while the model streams closes the block, as a direct tool
step does. The trace keeps the text. It keeps it in two blocks.

**Only the `compose` result reaches the model.** A nested result does not
call `delivered(call)`, and it does not move `readThrough`. The model read
the composition result alone.

**A nested `terminate` does not end the activation.** The flag says that a
batch of the model has nothing more to do. The code is not a batch of the
model. The composer ignores the flag, and the `compose` result never sets
it.

## Approval

**A harness hook does not see a nested call.** The Claude executor asks
`canUseTool` for a tool outside the tools that the room hosts, and it
records the answer as an `approval` step. `compose` is one of the hosted
tools, so the hook never sees `compose`, and never sees the `bash` that a
composition calls.

**The `compose` option takes an `approve` hook.** The composer calls it
with `uses`, `code`, and the `ToolContext` of the `compose` call, without
`record`. It calls the hook before it evaluates any code, and records the
answer as an `approval` step. A denial fails the composition with no ledger
and no effect. With no hook, the composer allows every composition of the
catalog.

```ts
interface ComposeOptions {
  readonly evaluator: Evaluator;
  readonly approve?: (
    request: { readonly uses: readonly string[]; readonly code: string },
    ctx: Omit<ToolContext, 'record'>,
  ) => Promise<'allow' | 'deny'> | 'allow' | 'deny';
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
tool, no room, and no `ToolContext`. The composer gives it the code, the
names, one function to call a binding, and the abort signal.

```ts
interface Evaluator {
  evaluate(input: EvaluatorInput, signal: AbortSignal): Promise<JsonValue | undefined>;
}

interface EvaluatorInput {
  readonly code: string;
  readonly bindings: readonly string[];
  /** Calls one binding. It resolves to the binding value, or rejects with its error. */
  call(name: string, args: JsonValue): Promise<JsonValue>;
}
```

**The evaluator gives code no ambient authority.** The global scope holds
`tools` and the ECMAScript built-ins, except those that read the clock or
a random source. There is no module import, no filesystem, no network, no
process, and no timer.

| Name                                          | In a composition                                 |
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

**Every value that crosses is JSON.** Arguments cross from the code to the
composer, and binding values cross back, as JSON. An evaluator can then run
in the same process, in a separate process, or on a remote host with one
contract. A value that JSON cannot hold fails the call that carries it.

**An evaluator states its isolation.** A separate JavaScript context in
the same process limits the names that code reaches. It is not a security
boundary against hostile code. Each evaluator states its memory limit, its
CPU limit, and its isolation. [Trust](trust.md) states what the kernel does
not defend.

**The evaluator is separate from Codex Code Mode.** Codex Code Mode reads
host files outside the sandbox ([Codex](codex.md#the-trust-boundary)).
`nativeTools: 'none'` keeps it off. A Codex seat composes through the
`compose` tool, as every seat does.

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

| Evaluator            | Runs the code                                                        | Isolation and limits                                                                                                                        |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `quickjsEvaluator()` | In QuickJS compiled to WebAssembly, in the process of the host       | A fresh QuickJS runtime for each composition. A memory limit on its heap, and an interrupt handler that stops the code at the signal.       |
| `processEvaluator()` | In a `node:vm` context, in a child Node process for each composition | The child runs under `--permission` with no allow flag: no file, network, child process, worker, or addon. The host kills it at the signal. |

**The child entry of `processEvaluator` is one file.** Under
`--permission` with no allow flag, Node loads the entry and refuses every
other file read, so a relative import fails with `ERR_ACCESS_DENIED`. The
package builds the child entry as its own tsdown entry, and the entry
imports only `node:` built-ins. `packages/claude/tsdown.config.ts` builds
two entries in the same way.

**`quickjsEvaluator` builds on `quickjs-emscripten`.** The package is MIT,
and it has no native part. The evaluator sets the globals of the table
above before it runs the code.

**Cloudflare has no evaluator in the first version.** A worker cannot
start a process, and a worker loads WebAssembly only from its bundle. A
seat on `@ambionframework/cloudflare` has no `compose` option until an
evaluator for workerd exists.

## Failure, cancellation, and effects

**A composition is not a transaction.** A failure or a cancellation undoes
no completed call. The ledger states which calls completed. The composer
never retries a call. The code can catch the error of a binding and decide
what to do.

**The first uncaught error fails the composition.** The result names the
error and the call that raised it. The composer revokes further calls.

**The composer answers after every call settles.** A call can still run
when the code ends, such as a sibling of a failed call in `Promise.all`.
The composer waits for each such call to settle before it answers. So the
ledger holds the outcome of every call, and no effect runs after the model
reads the result.

**The code awaits every call that it starts.** A call that is still running
when the function returns fails the composition, after that call settles.

**`pending` marks a call that did not settle.** Only a cut or the limit
`compose.limits.time` can end a composition before a call settles. The
ledger marks that call `pending`, and its effect can still happen.

**The cut cancels the composition.** The composer passes the signal of the
activation to the evaluator and to each nested call. It starts no queued
call after the cut. A call that has started can complete its effect. The
result has the status `cancelled`.

**A retried activation runs its compositions again.** The room does not
run an effect once
([Durability](durability.md#5-what-the-room-does-not-promise)). A new
attempt gives each nested call a fresh id, so a composition is not a key
for an effect. A tool that must write once needs its own key, such as a
UNIQUE constraint on a table.

## Limits

**The limits live on the `compose` option.** A definition tool reaches no
limit of the runtime: `limits` goes to the executions, and the context of
a tool call carries none. So the composer reads its limits from its own
option. An absent field keeps the default.

| Limit                       | What it bounds                                      | Default    |
| --------------------------- | --------------------------------------------------- | ---------- |
| `compose.limits.calls`      | Nested calls in one composition                     | 64         |
| `compose.limits.concurrent` | Nested calls that run at the same time              | 8          |
| `compose.limits.bytes`      | UTF-8 bytes of the encoded return value             | 65,536     |
| `compose.limits.time`       | Wall time of one composition, within `ctx.deadline` | 120,000 ms |

**A composition that passes a limit fails.** The composer never cuts a
return value to fit. The error names the limit, so the code can return a
smaller value.

**The trace caps bound what a nested call leaves.** Each nested call
records two steps, and they count against `limits.trace.stepsPerPass`.
Each output counts against `limits.trace.toolOutputBytes`. The default of
64 calls keeps one composition at 128 steps of the 1,000 of a pass. The
trace can cut a nested output.

## Changes to other contracts

**The implementation updates these pages in the same change.** Until then,
each page states the current surface.

| Page                                                                   | Change                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Definitions and tools](agent.md)                                      | The `compose` option of a definition, and the `compose` field of a tool.                                                                                                                                                                  |
| [Executors](executors.md)                                              | `parent` on `tool_call` and `tool_result`, `record` in `toolContext`, `callId`.                                                                                                                                                           |
| [Trust](trust.md)                                                      | A harness approval hook sees no tool that the room hosts, so it sees no composition. `approve` is the one hook that sees one.                                                                                                             |
| [Workspace](workspace.md)                                              | The declared outputs of `sql`, `snapshot`, `bash`, `ps`, `wait`, and `fork`.                                                                                                                                                              |
| [Envelope](envelope.md)                                                | The four limits of the `compose` option and their defaults.                                                                                                                                                                               |
| [Pi](pi.md)                                                            | `toolsFor` passes the step sink of the activation to each call.                                                                                                                                                                           |
| [Technical facts](technical-facts.md) and [Toolchain](toolchain.md)    | The package `@ambionframework/evaluator`, and the count of packages.                                                                                                                                                                      |
| `biome.jsonc` and `scripts/import-rules.test.mjs`                      | `compose.ts` joins the vocabulary layer. `packages/evaluator/src` may import `@ambionframework/ambion`, and not `/testing` or the source of the core.                                                                                     |
| [Executors](executors.md#the-room-tools) and [Toolchain](toolchain.md) | The scripted executor of `/testing` gives each tool call a signal, the deadline, and a step sink.                                                                                                                                         |
| Export entries and snapshot                                            | The main entry exports the types `Evaluator`, `EvaluatorInput`, `ComposeOptions`, `ComposeLimits`, `CompositionResult`, and `LedgerEntry`. The snapshot lists values only, so only `evaluatorConformance` from `/conformance` changes it. |
| Changelog                                                              | The step vocabulary, `ToolContext`, `AmbionTool`, and the `sql` details.                                                                                                                                                                  |

## Acceptance

**The scripted executor runs the acceptance.** Today it gives a tool call
no signal, no deadline, and no step sink. The same change gives it all
three, so `settled(room)` waits for a deterministic composition, and a
test reads the nested steps. Items 1 and 6 also run on the live tier of
each family once.

1. **The tools compose unchanged.** A seat on each of Pi, Claude, and Codex
   composes `sql` and `snapshot` with the same code. Each nested call keeps
   its preparation, its checks, its provenance, its deadline, and its
   steps.
2. **The data stays out of the context.** A test passes a large result
   from one tool into another. The model receives only the returned value,
   and the trace holds the nested calls with their `parent`.
3. **Two evaluators run the same code.** `quickjsEvaluator()` and
   `processEvaluator()` pass `evaluatorConformance`, with no change to a
   tool. The suite covers the globals table, a memory limit, a cut, and
   JSON at each crossing.
4. **Failure keeps its facts.** An error, a cut, a limit, a denial, an
   invalid declared output, and an unawaited call each give the stated
   status and ledger. No nested call counts as delivered to the model, and
   no nested step gives its id to a direct call.
5. **Parallel calls keep their facts.** Code that starts more calls than
   `compose.limits.concurrent` runs the cap at a time. A `sequential` tool
   runs one call at a time. A failed call in `Promise.all` leaves its
   siblings to settle, and the ledger holds the outcome of each.
6. **Processes carry parallel work.** A composition starts several
   processes with `bash` and waits for each. The wall time stays near the
   time of the slowest process.
