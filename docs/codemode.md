# Code mode

**Status: proposed design.** These interfaces are not current package
exports. Code mode adds a way to compose existing tools with JavaScript.
The host provides tool bindings; a pluggable backend evaluates the code.

The agent writes instructions, while the runtime carries data between
calls. Filtering, joining, formatting, and passing existing values into
another tool consume no inference tokens copying those values. Only
explicit script outputs return to the model.

```js
const found = await tools.search({ query: 'battery research' });
const body = found.details.items.map((item) => item.excerpt).join('\n\n');
const document = await tools.create_document({ title: 'Findings', body });
output({ documentId: document.details.id });
```

Neither tool needs to understand JavaScript execution. The agent never
reproduces the excerpts to construct the document argument. Native calls
remain available outside code mode.

## Script contract

A script runs as an asynchronous JavaScript module with top-level `await`
and fresh local state. It receives two capabilities:

```ts
tools[name](arguments); // Invoke an available tool; returns a promise.
output(value); // Append a JSON value to the model-visible result.
```

Names match the native catalog. Bracket access supports arbitrary tool
names. Existing descriptions and input schemas document the bindings;
code-mode output schemas, when declared, document their structured data.

Tool results, progress, and expression values are not automatically
printed. A script with no `output` calls returns only completion status.
The runtime exposes no Node globals, imports, filesystem, network, or
process access. Those capabilities require explicitly bound tools.

Local variables last for one execution. Shared storage, including saving
and loading structured values across agents, is supplied through ordinary
tools. It is not part of the JavaScript backend contract.

## Native compatibility and structured outputs

**Bindings always return the existing native result.** For an Ambion tool
that means `string | ToolResult`. Structured code accesses `result.details`;
text-only tools remain usable as strings. A schema never causes automatic
unwrapping or changes the binding's outer return shape.

Tools can opt into a declared code-mode payload with two small additions:

```ts
interface ToolContext {
  // Existing fields remain unchanged.
  readonly invocation?: 'direct' | 'codemode';
}

interface AmbionTool {
  // Existing fields remain unchanged.
  readonly codeMode?: {
    readonly output: TSchema; // Schema of ToolResult.details in code mode.
  };
}
```

The host sets `invocation`; scripts cannot forge it. Absent means `direct`
for existing callers. The field describes the immediate consumer, not
authority or whether code will later emit the value to the model.

A tool may tailor presentation and structured data to that consumer:

```ts
const codeMode = {
  output: Type.Array(
    Type.Object({ id: Type.String(), excerpt: Type.String() }),
  ),
};

async function execute({ query }, ctx) {
  const items = await search(query);
  return {
    content:
      ctx.invocation === 'codemode'
        ? []
        : [{ type: 'text', text: renderResults(items) }],
    details: items,
  };
}
```

This is the proposed metadata and implementation of a tool whose input
schema declares `query`. It still returns a `ToolResult` in both modes.
The mode does not change permissions, side effects, or control semantics.
Existing tools without `codeMode` remain bindable and need no changes.

For a declared output, the host validates `details` against the schema
before returning it to the script. Returning a string instead is a
contract violation. An invalid output rejects the binding with an error
that identifies the tool, the invalid paths, and that invocation already
completed. Validation does not roll back effects or authorize a retry.
The host preserves the original result and any control effects even
when output validation fails. Undeclared outputs are not schema-validated.

Output schemas make composition predictable; they are not a transport
format. Backend bindings must transfer supported native values without
silently changing their shape. Unsupported values fail explicitly.
Each backend documents its supported value representation, and the host
checks compatibility with the tools it exposes.

## Host and backend

The [agent executor](executors.md) runs the model. The code-mode host
dispatches native calls and collects explicit outputs. The backend runs
JavaScript. The host selects and configures the backend independently
of tool definitions.

```ts
interface CodeModeHost {
  invoke(name: string, args: unknown): Promise<string | ToolResult>;
  output(value: JsonValue): void;
}

interface CodeModeBackend {
  run(
    code: string,
    toolNames: readonly string[],
    host: CodeModeHost,
    signal: AbortSignal,
  ): Promise<void>;
}
```

`TSchema` is the existing TypeBox schema type. `JsonValue` represents JSON
values chosen by the implementation. A backend maps script bindings to
these host methods. It receives no tool implementation or room object.
An in-process isolate, separate process, or remote backend can implement
the same interface. Resource limits and containment belong to backend
configuration; a separate JavaScript context alone is not a promised
security boundary. See [Trust](trust.md).

The host restricts dispatch to tools available in this activation and
supported by its integration. It preserves their argument preparation,
validation, permissions, ordering, and provenance, and assigns each
nested call its own call ID. Code mode cannot restore tools omitted from
a closing activation or recursively invoke its own execution tool.

The integration must preserve full native results. Ambion's current
`RoomTool` adapter keeps content alone and differs in argument preparation
order from Pi's tool adapter; it cannot serve as a lossless structured
binding. See the tool-hosting discussion in [Executors](executors.md).

Control-sensitive tools require explicit executor integration. In
particular, Ambion's `terminate` depends on native call batches; neither
sequential `await` nor `Promise.all` defines such a batch. The initial
implementation omits tools whose termination or mandatory delivery
semantics it cannot preserve. It must not reinterpret termination as
"any nested result ends the activation."

Hidden script results do not count as model delivery. Receiving them in
JavaScript must not call `delivered(call)` or advance model-consumed read
tracking. Emitting a derived count does not mean the model read the source
result. Nested calls retain normal trace events, linked to the execution,
without automatically placing their payloads in model context.

## The execution tool

One additional native tool, `execute_code`, accepts:

```ts
interface ExecuteCodeArguments {
  readonly code: string;
}
```

It awaits `backend.run` with the host's available binding names and the
activation's abort signal. The host supplies execution limits, collects
outputs, and returns them using the executor's existing tool-result
format. In Ambion, `details` holds:

```ts
interface CodeModeResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly outputs: readonly JsonValue[];
  readonly error?: { readonly message: string };
}
```

`content` renders that status, explicit outputs, and any compact error
for the model. Errors do not dump intermediate values. Outputs emitted
before failure remain marked by the failure status. Exceeding the output
budget fails explicitly rather than silently truncating values.

Scripts must await their tool calls. Unfinished calls at module completion
fail the execution and revoke further dispatch. The backend releases each
execution environment on completion, error, timeout, or cancellation.
The host forwards cancellation to native calls and checks it before
dispatching queued work.

Execution is not a transaction. Cancellation or failure does not undo
completed effects or guarantee that in-flight work stops. Output-schema
errors are also post-invocation failures. Code mode never automatically
retries native calls.

## Acceptance

1. Existing tools compose without modification, using their original
   schemas, preparation, native result shapes, and host authority.
2. Large values are transformed and passed onward while the model receives
   only explicit observations. Optional output schemas validate `details`
   without changing the binding's return shape.
3. Two backends run the same supported script and tool bindings without
   requiring changes to the native tools.
4. Errors, cancellation, ordering, control integration, and model-delivery
   tracking preserve their stated semantics, including partial effects.
