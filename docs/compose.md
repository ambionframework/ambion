# Compose

**Status: the current contract of 0.6.0.** The `compose` option adds the
`compose` tool, and the main entry exports its types and `COMPOSE_GUIDANCE`.
Skill [macros](macros.md) run by name. The package
`@ambionframework/compose/runtime` holds `quickjsEvaluator` and `processEvaluator`,
and both pass `evaluatorConformance`. The live run of CP6 is in
[the compose evidence](../planning/compose-evidence.md).
[The 0.6.0 plan](../planning/next.md) holds the work.

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
| macro        | A compose program that a skill stores. A compose call runs it by name.          |
| evaluator    | The pluggable backend that evaluates the code. It holds no tool.                |
| ledger       | The nested calls of one compose call, in order, with the outcome of each.       |

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

**The tool schema is one object with four optional fields.** A model
provider accepts no `anyOf` at the top of a tool schema. `resolveProgram`
checks the two forms. A call that gives `uses` and `code`, or `macro` and
`args`, is valid. Any other mix is a refusal with no ledger and no effect.

**`uses` declares the tools before the code runs.** `compose` refuses a
name that the catalog does not hold. It checks `uses` first, then asks
the [approval](#approval), then evaluates the code. A macro holds its own
`uses`, so a macro call gives none. A refusal at either
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

**A failed or cancelled compose call throws.** Its message renders the error
and the ledger. Every executor kind turns a thrown error into an error result
with that message. The model then knows which calls completed. It knows which
effects can stand. The error is a `ComposeFailure`, an internal class of the
core that the main entry does not export. Its `details` hold the
`ComposeResult`, and no executor passes them on. The ledger never holds the
input or the output of a call.

**The content is the contract.** Claude and Codex host a definition tool as
a `BoundTool`, and a `BoundTool` keeps the content alone
([Executors](executors.md#the-room-tools)). The `ComposeResult` of a
completed call reaches a Pi seat in `details`, and the trace keeps it. On
Claude and Codex, the model and the trace read the rendered content.

## The catalog

**The `compose` tool describes its bindings as TypeScript.** The core
renders one signature for each tool that the seat can bind. It reads the
input schema, the description, and the declared output of the tool. The
catalog is part of the description of `compose`, so the model reads it
once for each activation. The example below shortens the descriptions.

```ts
declare const tools: {
  /** Run statements on the shared database. */
  sql(args: {
    sql: string;
    export?: string;
    import?: string;
    params?: (string | number | null)[];
    rows?: number;
  }): Promise<{
    database: string;
    count: number;
    columns: string[];
    rows: Record<string, string | number | null>[];
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
activation. The comparison that the status names counts the catalog in the
input tokens of the seat.

**The live comparison measured the catalog only.** The seat ran the chain
task once with `compose` and once without it, on each executor kind. No
seat called `compose` for the chain task, so the comparison holds no
saving. The run with `compose` cost more input tokens:

| Kind   | Input with | Input without | Output with | Output without |
| ------ | ---------- | ------------- | ----------- | -------------- |
| Pi     | 55016      | 45861         | 934         | 1028           |
| Claude | 60065      | 33964         | 828         | 627            |
| Codex  | 34575      | 23767         | 439         | 442            |

Each figure is one run. The Claude run with `compose` made four `sql`
calls, and the run without it made one, so the calls of the seat also
change the figure.

## Guidance

**The model decides when to compose.** The name of the tool gives little
of that decision. The guidance gives the rest. It states when a compose
call helps, and when a direct call is the right call.

**`compose` adds guidance, as a bundle does.** `describeExecutor` joins
the guidance of `compose` after the guidance of the bundles, in the
`guidance` field of the executor. The prompt renders it after the speaking
policy, as it renders the guidance of every bundle
([Executors](executors.md#the-prompt-the-driver-renders)). The description of
`compose` holds one sentence and the catalog.

**The text is `COMPOSE_GUIDANCE`.** `compose.ts` holds it, and the main
entry exports it. `ComposeOptions.guidance` replaces it, as the `speaking`
option replaces `DEFAULT_SPEAKING`. The text follows:

```text
compose joins your tools in one call. Put the tools that you use in
uses, and the body of an async function in code. Each tool is
tools.<name>, and the description of compose gives its signature. You
read only the value that the code returns.

Plan the tool calls of a task before you make the first call. When the
plan has two or more tool calls, make them in one compose call. Each
result that you read costs tokens and one more turn.

Use compose when:
- the result of one tool is the input of another tool, also when you
  filter or map the result first;
- the task gives the rule for the next step. Code can apply the rule
  with if, filter, and map;
- a tool gives a large result, and you need a count, a filter, or a
  few fields of it;
- you call one tool for many inputs;
- you start several processes and wait for each.

Call a tool directly only when:
- the next step needs your judgment of the result, and the task gives
  no rule for it;
- you make one call and need its whole result;
- you speak. say, schedule, seat, unseat, dismiss, and recall are not
  in compose.

For example, "snapshot each file that a query finds" is one compose
call. Do not call sql first to read the paths:
  const found = await tools.sql({ sql: 'SELECT path FROM files' });
  return tools.snapshot({ paths: found.rows.map((row) => row.path) });

Return only the values that you need to read. The code has no clock,
no random source, and no I/O except through tools. A failed compose
call lists each call and its outcome. A completed call can have had an
effect, so read the list before you call a tool again.

When a skill names a macro, call compose with the macro and its args,
and write no code. The macro holds the code and names its own tools.
```

**The guidance lists the macros of the seat.** A seat with macros gets
one more block after the text. The block holds one line for each macro:
its name, a colon, and its description on one line. A seat with no macro
gets no block. `ComposeOptions.guidance` replaces the text and keeps the
block, because the block is data of the skills. The description of
`compose` and the guidance of the skills do not change.

```text
The macros of your skills. Run one with compose({ macro, args }):
- lab-drift/snapshot-drift: Snapshot the files of every run with a label. Returns the count and the refs.
```

**The description of `compose` is one sentence and the catalog.** The
sentence is `Join your tools in one call. Code calls them as
tools.<name>, and you read only the value that it returns.` The catalog
follows it.

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

**`compose` sets `ToolContext.composeCall` on each nested call.**
[Definitions and tools](agent.md#tools) states the field.

```ts
interface ToolContext {
  // The existing fields stay the same.
  readonly composeCall?: string;
}
```

**The workspace tools declare their outputs.** `sql`, `snapshot`, `bash`,
`status`, `cancel`, `wait`, `ps`, and `fork` set `compose: { output }`. Every
other tool binds as text. [Workspace](workspace.md#declared-outputs) states
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
`claude()`, and `codex()` each call `describeExecutor`, so every executor kind
gets the tool the same way. The frozen executor keeps no `compose` field:
the tool closes over the option.

**The name `compose` is reserved.** `appendTools` refuses a tool of that
name while it flattens the tools of the options, before `compose` is
appended. The check of the agent tools runs later, and its duplicate rule
refuses a second `compose`.

**Five files of the vocabulary layer hold the tool.** `compose.ts` holds
the types, the checks, and `COMPOSE_GUIDANCE`. `compose-tool.ts` holds the
tool and the hosting exports. `compose-run.ts` holds the run of one compose
call. `compose-catalog.ts` renders the catalog, and `compose-macros.ts`
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
   evaluator.

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
  readonly evaluator: Evaluator;
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
  /** The checked arguments of a macro. Absent for free code. */
  readonly args?: JsonValue;
  /** Calls one binding. It resolves to the binding value, or rejects with `{ message, details? }`. */
  call(name: string, args: JsonValue): Promise<JsonValue>;
}
```

**The evaluator gives code no ambient authority.** The global scope holds
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
The Codex executor keeps it off in every seat. A Codex seat uses the `compose` tool,
as every seat does.

**A seat opts in with an evaluator.** The executor options take a
`compose` option. With no option, the seat has no `compose` tool.

```ts
import { quickjsEvaluator } from '@ambionframework/compose/runtime';

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

**`@ambionframework/compose/runtime` holds the first two evaluators.** Both pass
one conformance suite, `evaluatorConformance`, which
`@ambionframework/ambion/conformance` exports beside the other suites of
the kernel.

| Evaluator            | Runs the code                                           | Memory and CPU                                                                                                                                   | Isolation                                                                                                  |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `quickjsEvaluator()` | In QuickJS compiled to WebAssembly, in the host process | A memory limit on the QuickJS heap (64 MiB), and a CPU limit on the time of the code (10,000 ms). A cut ends the run between stretches           | A fresh QuickJS runtime for each compose call. It shares the process of the host.                          |
| `processEvaluator()` | In a `node:vm` context, in a child Node process         | `--max-old-space-size` on the old space of the child heap (64 MiB). An ArrayBuffer is outside that bound. The host kills the child at the signal | The child runs under `--permission` with no allow flag: no file, network, child process, worker, or addon. |

**`quickjsEvaluator` uses the synchronous QuickJS build.** The asyncify
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

[Envelope](envelope.md#the-limits-of-a-compose-call) names the four fields,
what each bounds, and its default.

**The time limit ends at the earlier bound.** `compose` stops the code at
`compose.limits.time` from its start, or at `ctx.deadline`, whichever
comes first.

**A compose call that passes a limit fails.** `compose` never cuts a
return value to fit. The error names the limit, so the code can return a
smaller value.

**The `calls` limit rejects the binding, so code can catch it.** The call
past the limit gets no id, no ledger entry, and no step. Its binding
rejects with an error that names `compose.limits.calls`. A name that the
compose call does not bind, and arguments that break the schema, reject in
the same way. Code that catches the error can return what it has. The other
limits end the compose call.

**The time limit covers the drain of late calls.** The timer starts before
the code and stops after every call settles. It can fire while `compose`
waits for a call that outlived the code. The compose call then fails with
the status `failed`, and the ledger marks each call that has not settled
`pending`.

**The trace caps bound what a nested call leaves.** Each nested call
records two steps, and they count against `limits.trace.stepsPerPass`.
Each output counts against `limits.trace.toolOutputBytes`
([Envelope](envelope.md#the-limits)). The trace can cut a nested output.

## Acceptance

**The scripted executor runs the acceptance.** It gives a tool call a
signal and the deadline. It hands the step sink to `compose` through
`invokeTool`, so `settled(room)` waits for a deterministic compose call. A
test reads the nested steps. The scripted executor records the text of a
result, so a room test reads the status and the ledger from the rendered
content. A unit test of the `invoke` of `compose` reads the `ComposeResult`.
Items 1, 6, and 7 add a live run, which CP6 holds.
[The compose evidence](../planning/compose-evidence.md) records it.

1. **The tools compose unchanged.** Each of Pi, Claude, and Codex hosts
   `compose` as one more definition tool. A workspace test binds `sql` and
   `snapshot` through `invokeTool`, and a macro test runs them on the
   scripted executor. A Pi seat on a scripted stream and a Claude seat on a
   fake executable run `compose` over a test tool. Each nested call keeps its
   preparation, its checks, its provenance, its deadline, and its steps.
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
   [The fan-out evidence](../planning/compose-evidence-fanout.md) holds
   each run.
