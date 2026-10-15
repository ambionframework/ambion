# @ambionframework/compose

The `compose` tool of an [Ambion](https://ambionframework.com) seat, and
the runtime that runs its code. `composeExtension(options)` makes the seat
extension that adds the `compose` tool and the `describe` tool. A runtime runs
the code of one compose call. The code calls the tools of the seat as `tools.<name>(args)`.
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

## `quickjsRuntime(options)`

`quickjsRuntime()` runs the code in QuickJS compiled to WebAssembly, in the
host process. Each compose call gets a fresh runtime and its own WebAssembly
memory.

| Option        | Meaning                                                           | Default |
| ------------- | ----------------------------------------------------------------- | ------- |
| `memoryLimit` | The bytes of the QuickJS heap and of its WebAssembly memory       | 64 MiB  |
| `cpuLimit`    | The milliseconds that the code runs, summed between settled calls | 10,000  |

**The runtime is not a defense against hostile code.** A separate context
limits the names that code reaches. The code of a model is not hostile, and
the runtime bounds its mistakes. Code that catches an out-of-memory error can
make Emscripten print an `Aborted(...)` line to stderr. The evaluation keeps
the value of the code.

[Compose](https://github.com/ambionframework/ambion/blob/main/docs/compose.md#the-runtime)
states the contract of a runtime, its globals, and its isolation.
[Trust](https://github.com/ambionframework/ambion/blob/main/docs/trust.md)
states what the kernel does not defend.

## Test a runtime

`@ambionframework/compose/conformance` exports `composeRuntimeConformance(make)`.
It returns a list of cases, and each case has a `name` and a `run` function.
Pass `make` a function that returns a fresh runtime with a small memory
limit.

```ts
import { composeRuntimeConformance } from '@ambionframework/compose/conformance';
import { quickjsRuntime } from '@ambionframework/compose/runtime';
import { it } from 'vitest';

for (const c of composeRuntimeConformance(() => quickjsRuntime({ cpuLimit: 500 }))) {
  it(c.name, c.run);
}
```
