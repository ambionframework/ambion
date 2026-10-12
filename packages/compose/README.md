# @ambionframework/compose

The runtime of the `compose` tool of an
[Ambion](https://ambionframework.com) seat. A runtime runs the code of one
compose call. The code calls the tools of the seat as `tools.<name>(args)`.
`pi()`, `claude()`, and `codex()` give every seat `quickjsRuntime()` by default.
A host passes `compose: { runtime }` to choose another runtime.

## Install

```sh
pnpm add @ambionframework/ambion @ambionframework/compose
```

Every package needs Node 22.19 or newer.

## Use

Pass a `compose` object to an executor to choose the runtime, an approval hook, guidance, or limits.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { quickjsRuntime } from '@ambionframework/compose/runtime';
import { pi } from '@ambionframework/pi';

const analyst = defineAgent({
  name: 'analyst',
  identity: 'Reads the lab records.',
  executor: pi({
    instructions: 'Compose the lab tools when one result feeds another.',
    model: 'anthropic/claude-sonnet-5',
    compose: { runtime: quickjsRuntime() },
  }),
});
```

## The runtime

| ComposeRuntime     | Runs the code                                           | Memory and CPU                                      | Isolation                                                                                    |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `quickjsRuntime()` | In QuickJS compiled to WebAssembly, in the host process | A memory limit and a CPU limit, both in the options | A runtime and a WebAssembly memory for each compose call. It shares the process of the host. |

**The runtime is not a defense against hostile code.** A separate context
limits the names that code reaches. The code of a model is not hostile, and
the runtime bounds its mistakes. [Trust](https://github.com/ambionframework/ambion/blob/main/docs/trust.md)
states what the kernel does not defend.

**The code has no ambient authority.** The runtime runs one setup script
in a fresh context. It makes these names throw or absent.

| Name                                          | In the code                                        |
| --------------------------------------------- | -------------------------------------------------- |
| `Date.now()`, `Date()`, `new Date()`          | Throws. A tool gives the time.                     |
| `new Date(value)`, `Date.UTC`, `Date.parse`   | Works.                                             |
| `Math.random`                                 | Throws.                                            |
| `WeakRef`, `FinalizationRegistry`             | Absent.                                            |
| `Intl`, `performance`, `crypto`               | Absent.                                            |
| `setTimeout`, `setInterval`, `queueMicrotask` | Absent. `await` orders the work.                   |
| `require`, `import`, `process`, `fetch`       | Absent. The code reads no module, file, or socket. |

**A macro reads its arguments as the global `args`.** When the input of an
evaluation has `args`, the code reads them. Free code has no `args`, and
`typeof args` is `'undefined'`.

**Every value that crosses is JSON.** Arguments, binding values, errors, and
the return value cross as JSON. A function, a cycle, a bigint, or a number
that is not finite fails the call with an error that names the place. An
error of a binding reaches the code as an `Error` with the same message and
`details`.

## `quickjsRuntime(options)`

| Option        | Meaning                                                           | Default |
| ------------- | ----------------------------------------------------------------- | ------- |
| `memoryLimit` | The bytes of the QuickJS heap and of its WebAssembly memory       | 64 MiB  |
| `cpuLimit`    | The milliseconds that the code runs, summed between settled calls | 10,000  |

**The synchronous build runs several calls at once.** Each tool is a host
function that returns a promise. The host settles the promise when the call
settles, so `Promise.all` runs its calls together.

**The CPU limit ends a loop.** The host thread cannot see a signal while
the code runs. The interrupt handler reads the signal and the CPU limit, so a
loop ends at the limit. A wait for a call does not count.

**An evaluation disposes every handle.** QuickJS aborts the process when it
frees a runtime that still holds one. The tests run the debug build and fail
on a leak. When the engine stops a job at a limit or at a cut, it leaves
objects that no handle names, and the evaluation then frees nothing. The
module of the evaluation is its own, so the garbage collector reclaims it.
Code that catches an out-of-memory error leaves the same objects. The free of
the runtime then aborts, the evaluation keeps the value of the code, and
Emscripten can print an `Aborted(...)` line to stderr.

## Test a runtime

`@ambionframework/ambion/conformance` exports `composeRuntimeConformance(make)`.
It returns a list of cases, and each case has a `name` and a `run` function.
Pass `make` a function that returns a fresh runtime with a small memory
limit.

```ts
import { composeRuntimeConformance } from '@ambionframework/ambion/conformance';
import { quickjsRuntime } from '@ambionframework/compose/runtime';
import { it } from 'vitest';

for (const c of composeRuntimeConformance(() => quickjsRuntime({ cpuLimit: 500 }))) {
  it(c.name, c.run);
}
```
