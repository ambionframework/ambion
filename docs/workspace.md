# The workspace

This document is the design contract for the workspace: the identity and
data boundary an agent connects to when it is defined. The workspace is
shipped. The handle, the resolver and the built-in tools live in
[`workspace.ts`](../packages/ambion/src/workspace.ts), the adapter around a
just-bash instance in [`bash-env.ts`](../packages/ambion/src/bash-env.ts),
the two backends in [`just-bash.ts`](../packages/ambion/src/just-bash.ts),
and the public shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md) first: a workspace attaches to the agent that
document specifies, and changes none of its eight rules.

One sentence:

> **A workspace is the identity and data boundary an agent connects to when
> it is defined — a container of persistent entities, each reachable from a
> tool through a context object and built fresh at the moment the tool
> runs: a shared filesystem and computer today, and reminders and tasks
> once they exist.**

The facts stated here about `just-bash` (3.4.2) and
`@earendil-works/pi-agent-core` (0.84.3) come from probe scripts run
against the installed packages and from their source.

---

## 1. What a workspace is

A session has no storage of its own. Its record holds what was said. It
holds nothing an agent read from a disk or wrote to one. A workspace is the
missing layer: an identity and data boundary that a connected agent's tools
reach into.

**A workspace decides what a tool may reach; the backend decides how far
that reach is enforced.** A tool holds no raw handle onto whatever backs a
workspace. It calls `ctx.workspace()` (§4) and receives a `Workspace` value
the runtime built for that agent, scoped the way the backend scopes it. §8
says how much the just-bash backend enforces, and §10 what a backend on a
real machine adds.

**A workspace holds an identity for the agents that use it**, the way
[`presence.md`](presence.md) holds one for the people who visit. A person's
identity comes from the host, which authenticates them and vouches for the
name it passes (`presence.md` §3). An agent has no visit to hold a
credential. A workspace provisions one for it, inside `connect` (§7).
**The boundary covers the sandbox and stops there.** A tool call that
leaves the workspace — an external API, a secret, another service — needs
a separate mechanism: a credentials provider paired with a sidecar proxy,
injecting a credential or issuing a short-lived token per call.
[`planning/backlog.md`](../planning/backlog.md) tracks that boundary. This document
leaves it out.

**A workspace is a container of persistent entities, each of a different
kind.** The filesystem and shell (§8) are one kind. Reminders and tasks
(§11) are a second, once they exist. Nothing bounds the set to these two.
Every kind reaches a tool the same way, through `ToolContext` (§4), and
every kind is held under the workspace's own name for as long as the
workspace lasts.

**A workspace outlives any agent or session that uses it**, the same way a
session's record outlives any one run (`agent.md` §5). It is durable by its
own name (§2). An agent defined later can connect to a workspace an earlier
agent used and find what is there. A reminder, once §11 exists, attaches to
the session where the work happens, so the workspace that holds it has to
survive past that session.

**A session connects to no workspace of its own.** A workspace is optional
per agent (§3). One room may seat agents that connect to different
workspaces beside agents that connect to none, and hold agents in reserve
the same way ([`roster.md`](roster.md) §1).

---

## 2. defineWorkspace and destroyWorkspace

```ts
import { defineWorkspace } from '@ambionframework/ambion';

interface WorkspaceHandle {
  readonly name: string;
}

const teamSite = defineWorkspace({ name: 'team-site' });
```

**`name` is the only public field, and it is the durable identity.** The
same name, defined again in a later process, reaches the same workspace.
`defineWorkspace` is synchronous, the same way `startSession` is
(`agent.md` §5): it returns a usable value at once. Everything a workspace
does for an agent happens later, inside `connect` (§7).

**The handle carries its backend and its destroyed mark as fields the
public type does not show.** `types.ts` brands `AgentDefinition` with a
symbol key, `AGENT_BRAND`. A `WorkspaceHandle` takes the same shape, with
its `WorkspaceBackend` (§7) and a destroyed flag behind the brand. No table
keyed by name holds either of them. The one thing the runtime remembers
across calls is which names are taken, the way `session.ts` keeps its
`running` map of session names.

**A second `defineWorkspace` call for a name already defined in this
process is refused**, the same way `startSession` refuses a name already
running (`agent.md` §5). One name has one handle for the life of the
process, until `destroyWorkspace` (below) frees it.

**An optional `backend` field takes a `WorkspaceBackend`**, the way a
session's `repo` option takes a `SessionRepo` (`agent.md` §5). §7 specifies
the two functions it needs, `connect` and `destroy`. Nothing here is a
class to extend: a `WorkspaceBackend` is a plain object holding those two
functions, and the natural way to build one is a factory function that
closes over whatever configuration it needs, the shape `directoryBackend`
below has. Without the `backend` field, the handle holds an in-memory
just-bash filesystem of its own (§8). With it, the factory decides what
`connect` builds. `defineWorkspace`'s own API is the same either way.

```ts
const teamSite = defineWorkspace({
  name: 'team-site',
  backend: directoryBackend('/var/ambion/team-site'),
});
```

**There is no `startWorkspace` and no `stopWorkspace`.** A workspace runs
no agent and consumes no model call on its own, so nothing needs bringing
up or taking down. It exists the moment its name is defined, the way
`readSession` reads a name with nothing standing up.

**`destroyWorkspace` retires a workspace for good.** Nothing about a
workspace runs, so there is nothing to stop and start again. Retiring one
is terminal:

```ts
import { destroyWorkspace } from '@ambionframework/ambion';

await destroyWorkspace(teamSite);
```

It marks the handle destroyed, then calls `WorkspaceBackend.destroy()`
(§7) once. That call performs the hard deletion: a directory-backed
workspace's files, a real-machine backend's provisioned users and their
homes, the in-memory default's filesystem. The mark comes first so a tool
call that lands while the backend deletes resolves `undefined` (§4), and a
second `destroyWorkspace` on the same handle does nothing. A backend that
fails to delete leaves the workspace live, and the caller sees the
failure. Once the deletion is done, `destroyWorkspace` frees the name. A
later `defineWorkspace` call for the same name is accepted and starts from
nothing.

**A connected agent's next `ctx.workspace()` call sees the mark.** Every
call resolves fresh (§4), so there is no cached value to invalidate. A
destroyed handle is one `ctx.workspace()` refuses to build from. The call
resolves `undefined`, the same value an agent with no workspace field gets.

---

## 3. Connecting an agent: defineAgent and defineHuman

```ts
const materialsAgent = defineAgent({
  name: 'materials-tracker',
  identity: 'Materials Tracker Agent.',
  instructions: '…',
  model: 'anthropic/claude-sonnet-5',
  workspace: teamSite,
});
```

**`workspace` is an optional argument to `defineAgent`.** `defineAgent`
takes a `name`, an `identity`, `instructions`, a `model`, and an optional
`tools` array today (`agent.md` §2). `workspace` joins that list the same
way `tools` does: present for an agent with something to reach through it,
absent for an agent that reasons and nothing else.

**Not every agent needs one.** An agent with nothing to read or write
connects to no workspace, the same way a human carries no tools (`agent.md`
§4). A workspace matters once an agent has something to reach through it.

**`defineAgent` refuses a `tools` entry named `read`, `write`, `edit`, or
`bash` for an agent that names a workspace.** Those four names are the
built-in set (§5). A custom tool with one of those names would fight the
built-in for the same name on the model's menu, or replace it silently.
`defineAgent` has the `tools` array and the `workspace` argument in hand,
so it makes the check itself. An agent with no workspace keeps all four
names free.

**`startSession` refuses an assistant that names a workspace**, the same way
it refuses one that carries tools (`assistant.md` §12, §17;
`assertAssistant` in `assistant.ts` checks `tools.length > 0`).
`startSession` is the one place that knows a given `AgentDefinition` is
about to become the room's assistant. `defineAgent` builds a plain value and
has no way to know that.

**The refusal is a fail-fast check on a dead configuration.** `handsFor`
(`session.ts`) returns before it reaches `seat.def.tools.map(toPiTool)` for
the assistant's seat: the assistant is handed `[summarise]` or `[]` on every
activation. The built-in tools bind in that same skipped branch (§5), so an
assistant that named a workspace would reach neither them nor any tool of
its own. The field would be live in the definition and inert at runtime.
Refusing it at `startSession` catches that at the boundary where it is
written.

**`startSession` sees no workspace.** It takes what `agent.md` §5 lists —
a name, its assistant, its agents, the agents it holds in reserve, an
optional goal, `streamFn` and `repo` — and nothing changes there.

---

## 4. Reaching a workspace from a tool: ToolContext

`defineTool`'s `execute` function takes its parsed parameters and a context
object (`define.ts`; `agent.md` §3). The abort signal Pi gives the tool
call sits inside the context.

```ts
interface ToolContext {
  /** The calling agent's workspace, or undefined if it has none. */
  workspace(): Promise<Workspace | undefined>;
  readonly signal?: AbortSignal;
}

const readFile = defineTool({
  name: 'read_file',
  description: "Read a file from the agent's workspace.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (params, ctx) => {
    const workspace = await ctx.workspace();
    const result = await workspace?.env.readTextFile(params.path, ctx.signal);
    if (!result) return 'No workspace connected.';
    return result.ok ? result.value : result.error.message;
  },
});
```

**`execute` takes `(params, ctx)`.** Before the workspace landed it took
`(params, signal?)`. A tool that read the second parameter then reads
`ctx.signal` now. None of `examples/site`'s ten tools reads it: each
declares `execute` with one parameter or none.

**`ctx.workspace()` resolves fresh on every call, and calls `connect` every
time.** The runtime binds an activation's tools knowing which seat they
belong to (`handsFor` in `session.ts`), so `ctx` knows the agent. The call
does three things, in order:

1. The agent has no `workspace` field: resolve `undefined`.
2. The handle is destroyed (§2): resolve `undefined`.
3. Otherwise call `WorkspaceBackend.connect(agent, ctx.signal)` (§7) and
   resolve `{ name, env }` (§6).

Nothing is cached between calls. The `env` a tool receives is a new one
every time — a new `Bash` instance, for the in-memory default. §5's
built-in tools resolve the same way. A `destroyWorkspace` mid-activation is
therefore visible to the very next tool call, built-in or custom, with
nothing to invalidate. Two agents' tool calls running in parallel
(`agent.md` rule 1) need nothing to keep them apart: each call builds its
own `env` from its own agent's field.

**`ctx.workspace()` returns a promise because `connect` does real work.**
It creates a home directory, or a real OS user, when one is missing (§7),
and that work is async. A tool author whose `execute` is already `async`
(`agent.md` §3's example is) writes one more `await`.

**`ctx.signal` reaches `connect`.** Pi hands every tool call the run's
abort signal (`executePreparedToolCall` in `agent-loop.js`), `toPiTool`
passes it through, and `abort()` on a session fans out to it (`agent.md`
§5). Pi puts no timeout around a tool's `execute`: it awaits the promise,
and `Agent.abort()` fires the controller and nothing else. A `connect` that
hangs would hold the activation open, and `settled()` with it. Passing
`ctx.signal` into `connect` gives a backend that waits on something the one
way to stop waiting. The in-memory default has nothing to wait on and
ignores it.

**A `connect` failure is the tool call's failure.** `ctx.workspace()`
rejects with whatever `connect` rejected with. Pi's agent loop catches a
thrown `execute` and turns it into an error tool result the model reads
(`executePreparedToolCall`), so the failure is visible in the room the same
way any other tool failure is. Nothing runs `connect` before an
activation's first tool asks for it, so this is the only place the failure
can surface. The price is that a broken backend shows up inside an
activation, as a tool failure, and nowhere earlier. The design accepts that
price for a `connect` that repairs itself on every call (§7).

**Resolution is lazy.** A tool that calls nothing on `ctx` costs nothing:
no `connect`, no `Bash` instance, nothing built.

**A tool whose agent has no workspace gets `undefined`; nothing throws.**
The tool author decides what an absent workspace means for that tool.

**Nothing is merged into `defineAgent`'s `tools` array.** A workspace adds
no tool values to what an agent declares. §5 says where the baseline
filesystem tools come from.

**`ToolContext` is a type Ambion defines.** Pi ships a comparable idea,
`AgentHarnessToolContextSource`, resolved once per turn and handed to an
`AgentHarnessTool`'s `execute` as its context argument. That mechanism
belongs to `AgentHarness` (`harness/agent-harness.ts`), a self-contained
engine with its own lanes, compaction, and navigation. Ambion's runtime
imports Pi's lower-level `Agent` class (`activation.ts`, `session.ts`), and
`AgentHarness` appears in no file under `packages/ambion/src`. `ToolContext`
is addressed to `defineTool`'s own shape, at the layer Ambion builds on.
`planning/backlog.md` holds the wider question of which class is Ambion's
foundation.

---

## 5. Built-in tools

An agent connected to a workspace does not write its own file and shell
tools. The runtime binds a small set of built-in tools to every activation
of such an agent, the way `say` is a built-in every seat holds without
declaring it (`agent.md` rule 3), and the way the assistant's activation is
handed `summarise` (`assistant.md` §14). None of them appears in
`defineAgent`'s `tools` array.

**The built-in tools are Pi's own.** `@earendil-works/pi-agent-core`
exports four tool factories — `createReadTool`, `createWriteTool`,
`createEditTool`, `createBashTool` — each returning an `AgentHarnessTool`
named `read`, `write`, `edit`, and `bash`. Called with no options, each
gives Pi's tool unmodified: the same parameter schema, description, and
behavior Pi's harness gives a model. A workspace-connected agent gets
exactly these four. Pi's `harness/tools/index.ts` exports no fifth tool, so
this project invents none.

```ts
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-agent-core';

const read = createReadTool();
const write = createWriteTool();
const edit = createEditTool();
const bash = createBashTool();
```

**Binding one to an activation supplies the one argument Pi's tool is
missing, fresh on every call.** `AgentHarnessTool`'s `execute` takes five
arguments, `(toolCallId, params, signal, onUpdate, context)`, where
`context` is `ExecutionToolContext`, `{ env: ExecutionEnv }`. Ambion's
`AgentTool` (what `handsFor` hands a seat) takes the first four. The
wrapper passes its four arguments through, awaits `ctx.workspace()` (§4),
and passes `{ env: workspace.env }` as the fifth. `workspace.env` is an
`ExecutionEnv` (§6), so that argument is a plain assignment.

**When `ctx.workspace()` resolves `undefined`, the wrapper throws.** That
happens for a destroyed handle only; an agent with no workspace field has
no built-in tool bound (below). Throwing is how `say` and every other tool
signals failure (`agent.md` §3). Pi's agent loop turns the throw into an
error tool result the model reads.

**The wrapper spreads the original tool, replaces `execute`, and sets
`executionMode: 'sequential'`.**

```ts
const wrapped = { ...builtin, executionMode: 'sequential', execute: bound };
```

The spread carries `createEditTool()`'s `prepareArguments` along; a
wrapper that lists fields by hand drops it. `executionMode` answers a
problem a fresh `env` per call creates. Pi's `write` and `edit` serialize
mutations to one file through `withFileMutationQueue`
(`harness/tools/file-mutation-queue.ts`), whose state is a `WeakMap` keyed
on the `env` object. Pi's `Agent` runs a turn's tool calls in parallel by
default (`toolExecution` defaults to `"parallel"` in `agent.js`, and
`session.ts` passes no override). With one `env` per call, two `edit` calls
on the same file in one turn each get an empty queue, and one edit is lost.
A probe ran `edit('alpha' → 'ALPHA')` and `edit('beta' → 'BETA')` in
parallel on one file: fresh envs ended with `alpha\nBETA\n`, one shared env
ended with `ALPHA\nBETA\n`. Pi's loop runs a whole batch one call at a time
when any tool in it carries `executionMode: 'sequential'`
(`executeToolCalls` in `agent-loop.js`), which restores the order the queue
gave. None of the four factories sets the field itself. A batch that holds
one built-in call runs every call in that batch one at a time, custom tools
included. A batch of custom tools alone still runs in parallel.

**The wrapped value takes a one-line cast to `AgentTool`**, the way
`toPiTool` (`seat.ts`) casts a Pi-native tool. Strict mode does not
consider `Static<typeof readSchema>` assignable to `AgentTool`'s default
`params` type on its own.

**A custom tool reaches the same object.** `ctx.workspace()` returns the
same `Workspace` the four built-ins resolve on every call. An author whose
tool reads a file as part of a larger operation awaits `ctx.workspace()`
and calls `.env.readTextFile(...)` on the result. Methods no built-in
exposes, such as `listDir`, are reachable the same way.

**A tool defined with Pi's own shape reaches no workspace.** `agent.md`
§3's facade passes a Pi-native tool through unconverted, and its signature
has no room for `ToolContext`. The four built-ins are the one exception:
they reach a `Workspace` through the harness `context` argument they were
built to take. A hand-written Pi-native tool has no such argument.

**An agent with no workspace gets none of the built-in tools.** They bind
per activation, conditioned on the agent's `workspace` field.

**Connecting means all four; there is no opt-out.** An agent whose
`defineAgent` names a workspace gets `read`, `write`, `edit`, and `bash` on
every activation. An agent that wants filesystem access only through
narrower custom tools has no way to name a workspace and decline the four.
§12 lists this as open.

**A connected agent's system prompt states what the four tools reach, so it
does not have to find out by calling one.** `render.ts`'s `renderSystemPrompt`
checks `seat.def.workspace` — the same field `defineAgent` set (§3) — and, when
it is present, adds `WORKSPACE_PARAGRAPH`: the home path convention (§8), that
other agents on the same workspace share its files, the command set `bash`
carries (coreutils, `jq`, `yq`, `xan`, `sqlite3`, `js-exec`, `python3`), and
that there is no network. The paragraph is static prose, chosen at the point
`duties()` already assembles a seat's prompt, so it costs nothing beyond what
every activation already builds. It states the same facts §8 states about the
`Bash` construction, by hand, in a file that imports nothing from `just-bash.ts`
— `render.ts` stays pure (`agent.md`'s code rules), so the two are kept in step
by whoever changes one remembering the other, not by any check.

---

## 6. The Workspace value

```ts
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';

interface Workspace {
  readonly name: string;
  readonly env: ExecutionEnv;
}
```

**`Workspace` holds Pi's `ExecutionEnv` as a property.**
`@earendil-works/pi-agent-core` exports `FileSystem`, `Shell`, and
`ExecutionEnv extends FileSystem, Shell`: a `Result`-returning contract
whose methods never throw, covering `readTextFile`, `writeFile`, `listDir`,
`createDir`, `remove`, `exec`, and more — nineteen members, `cwd` and
`cleanup` included — with an `abortSignal` on every call that does work.
That is the whole reading, writing, listing, and command-running surface a
workspace needs. `agent.md`'s code rules call a third concern that
duplicates a dependency a design failure, so `Workspace` reuses the
contract as it stands.

**`env` is one property so a later kind of entity gets a property beside
it.** Reminders and tasks (§11) join as a second property. `ExecutionEnv`
owns names such as `remove`, `exists`, `exec`, `cleanup`, and `cwd`. A
`Workspace` that spread those members across its own surface would leave a
reminder API to avoid every one of them. `name` sits beside `env` because
the durable identity §1 stresses needs a place on the value.

**The runtime builds the object `ctx.workspace()` returns, per agent, per
call.** The runtime hands `Workspace` values out and accepts none from
caller code. `workspace.env` is whatever `WorkspaceBackend.connect`
returned (§7): an adapter around a `Bash` instance for the just-bash
backend (§9), or a real-machine environment (§10).

---

## 7. WorkspaceBackend: connect and destroy

```ts
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';

interface WorkspaceBackend {
  connect(agent: AgentDefinition, signal?: AbortSignal): Promise<ExecutionEnv>;
  destroy(): Promise<void>;
}
```

**A `WorkspaceBackend` is a plain object with two functions; nothing about
it asks for a class.** TypeScript checks the shape structurally, so a
`directoryBackend(path)` call returning `{ connect, destroy }` satisfies
`WorkspaceBackend` the same way a hand-written object literal would. Both
functions close over whatever the factory captured — a path, a naming
convention for OS users — which is the only state a backend needs, since
`connect` remembers nothing between its own calls (below).

**Two jobs live here: building one agent's environment, and hard
deletion.** `connect(agent)` returns the `ExecutionEnv` that becomes
`Workspace.env` (§6), already rooted at that agent's own home and already
carrying whatever identity the backend gives an agent. `destroy()` deletes
everything the backend holds under the workspace's name; only the backend
knows how (§2).

**`connect` builds the whole environment; the runtime builds none of it.**
A shape that handed the runtime a shared filesystem root and left it to
layer each agent's environment on top could not fit a backend on a real
machine (§10): a real user and a real shell are no plain filesystem. So
`connect` is the backend's job everywhere, the just-bash backend included,
and the runtime constructs no `Bash` instance of its own.

**`connect` provisions the agent's identity from the agent's `name`, and
checks nothing.** `connect` receives the agent's own value, the
`AgentDefinition` `defineAgent` returned, and reads `name` off it — the
same name the roster and the record use (`agent.md` §2). It creates
whatever that name needs inside the workspace: a home directory (§8), or a
real OS user (§10). Nothing is authenticated: an agent holds no visit and
has no credential to present.

**`connect` creates what is missing on every call, with `mkdir -p`
semantics, and remembers nothing between calls.** A real `useradd` fails
the second time it sees a name. `connect` succeeds every time. The
just-bash backend calls `fs.mkdir(home, { recursive: true })` on every
call: just-bash returns without error when the directory exists, and
creates it, parents included, when it does not (probed on `InMemoryFs` and
`ReadWriteFs`). A home removed out from under a workspace comes back the
next time any tool reaches for it. A backend on a real machine does the
equivalent: create the user when absent, leave it when present.

**`connect` runs one unconditional create and checks nothing first.** Pi
runs a turn's tool calls in parallel (§5), so two `connect` calls for the
same agent can overlap. A `connect` written as "call `exists`, then
`mkdir`" fails under that overlap: both calls see no directory, both create
it, and the second `mkdir` throws `EEXIST` (probed on both filesystems;
`mkdir` with `recursive: true` succeeds twice in the same probe). The
idempotent form has no window.

**`connect` fails when the home path holds something other than a
directory.** `fs.mkdir(home, { recursive: true })` throws
`EEXIST: file already exists` when a file sits at that path, and `connect`
rejects with it. The failure is the tool call's (§4). Nothing repairs a
wrong-kind path: deleting a file another agent wrote is a judgment
`connect` does not make.

**`connect` takes the tool call's abort signal.** §4 says why: Pi bounds a
tool's `execute` by that signal alone. A backend that waits on a process or
a network call watches the signal. The just-bash backend has nothing to
wait on and ignores it.

**Nothing calls `connect` before an activation's first tool asks for it.**
`ctx.workspace()` (§4) is the only caller. There is no separate
provisioning step and no `setup` to call early.

**Agent names are not namespaced by workspace, and the design accepts that
limit.** Two workspaces on one real-machine host that both provision an
agent named the same collide on that OS user, the same way two workspaces
over one directory backend would collide on a home path. A deployment that
runs several workspaces on one host keeps agent names unique across them.
The runtime does not check this, and `connect` does not either.

---

## 8. The just-bash backend

**[vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) backs
the in-memory default, and it is in scope for this work.** It runs a
virtual Unix filesystem and shell in-process: `Bash.exec` interprets bash
commands against whichever `IFileSystem` the instance was built over.

**One filesystem belongs to the workspace, and each connected agent gets
its own `Bash` instance over it.** The handle (§2) holds an `InMemoryFs`
when no `backend` field is given. `connect(agent)` (§7) creates the agent's
home in that filesystem and builds a `Bash` instance with `cwd` at the home
and `HOME` seeded in its environment. A `Bash` instance is cheap: a probe
measured about 0.8 ms per construction, and about 1.7 ms for a construction
plus one `echo`, so one per tool call costs little. Two instances over one
filesystem share every file. A write from one is visible to the other at
once, and two writes to one path from two agents end with the last one.

**`memoryBackend(options)` can seed a filesystem before any agent connects,
and read one back without an agent at all.** `options.seed` is a function,
`(write: SeedWriter) => Promise<void>`, called once before the first `connect`
resolves. `SeedWriter` is one method, `writeFile(path, text)`, each call doing
its own `mkdir -p` first; a seed function reads and writes one file at a
time — from disk, from a generator, from anywhere — rather than handing
`memoryBackend` an array it would have to hold in full before it could start.
`SeedWriter` names none of just-bash's own types, so a seed function commits
to nothing about what backs the filesystem it is writing into. `readFiles()`
walks the whole filesystem back out, sorted by path, skipping a symlink
rather than following it: following one risks reading the same content
twice under two paths, or looping forever on a cycle. Both close over the
one `InMemoryFs` the backend holds, the same instance every `connect`
builds a `Bash` over, so a host reaches the workspace's files without a
tool call or an agent to make one — the one thing `directoryBackend` gets
for free by sitting on a real directory. `memoryBackend`'s return type,
`MemoryWorkspaceBackend`, extends `WorkspaceBackend` with `readFiles()`;
passing it as `defineWorkspace`'s `backend` needs nothing beyond what §7
already asks for. The first `connect` lays just-bash's own coreutils and
QuickJS/CPython runtime into the filesystem as ordinary files under `/bin`,
`/usr` and `/proc` — about 190 of them, probed — so `readFiles()` returns
those too once any agent has connected. A caller that wants only what it
wrote reads `readFiles()` filtered to its own path prefix, the way
[`examples/site`](../examples/site)'s `driveFiles()` keeps to `/site/`.

**A seed that fails is retried on the next call, and `destroy()` is a one-way
gate, not a reset.** Both backends hold their one lazily-built filesystem
behind a small shared `lazyResource` helper (`just-bash.ts`): `get()`
memoises what `build()` returns, but a rejection clears the memo so the
next `connect` or `readFiles()` call tries again rather than staying
poisoned by one failed seed. `mark()` is the other side of that helper: once
called, every later `get()` rejects outright. `memoryBackend`'s `destroy()`
calls it immediately, since releasing memory cannot fail; `directoryBackend`'s
calls it only once the on-disk deletion has actually succeeded, so a backend
that fails to delete still leaves the workspace reachable for
`destroyWorkspace` (§2) to retry. Before this, both backends only forgot
their built filesystem on `destroy()` — the next `connect` or `readFiles()`
call, made directly on the backend rather than through the destroyed
`WorkspaceHandle`, silently rebuilt it, seed included. `memoryBackend`'s
export (this section) is what made that reachable: a host holding the
backend itself, the way [`examples/site`](../examples/site) holds
`driveBackend`, could resurrect a workspace `destroyWorkspace` was told to
end.

**`directoryBackend(root)` uses `ReadWriteFs`.** `ReadWriteFs` is the one
just-bash filesystem that writes through to a real directory (probed: a
`writeFile` through it lands on disk). `connect` builds the same `Bash`
instance over it. `ReadWriteFs` refuses a root that does not exist, so the
first `connect` creates the root, and `defineWorkspace` stays synchronous.
`OverlayFs`, just-bash's other disk-backed option, is copy-on-write: reads
come from disk, writes stay in memory, so it has no place in a durable
backend. `MountableFs` composes several roots and refuses a mount at `/`,
so it plays no part in what makes a directory backend durable either.

**The home is `/home/<name>`, and `connect` creates it.** This is the
just-bash backend's convention; the runtime imposes no path on any backend.
just-bash's `Bash` constructor writes a default layout into a fresh
`InMemoryFs` (`bin`, `dev`, `home`, `proc`, `usr`, and the `cwd` it was
given) and writes nothing into a `ReadWriteFs`. `ReadWriteFs.writeFile`
creates parent directories, but `ls ~` before the first write fails with
`ENOENT`. `connect`'s `mkdir` (§7) makes the home exist on both. Neither
filesystem starts with `/tmp` (§9).

**`/dev/null` is a plain file on both filesystems.** just-bash seeds an
empty `/dev/null` into a fresh `InMemoryFs` and treats it as a file: a
command that redirects into it appends to it (probed: `echo hi >/dev/null`
leaves three bytes there). `ReadWriteFs` starts without `/dev`, so the same
redirect creates `dev/null` under the root, on disk. A directory backend
therefore holds whatever agents discarded, and [`planning/backlog.md`](../planning/backlog.md)
tracks it.

**`env.cwd` is the agent's home for the life of the `env`, and nothing
tracks it further.** Pi's `FileSystem` declares `cwd` as a plain property,
and the adapter (§9) writes it once, at construction. Every `exec` runs
there unless the caller passes its own `cwd`. A `cd` inside one command
lasts for that command: just-bash's `exec` restores `cwd` and environment
after every call, and Pi's `NodeExecutionEnv` spawns a fresh `bash -c` per
call with `cwd` as a spawn option, so neither carries a `cd` across calls.
Pi's `bash` tool describes itself as executing "in the current working
directory" and passes `env.cwd` on every call. A command that needs to run
elsewhere writes `cd sub && npm test` in one call.

**The boundary is nominal.** just-bash is single-user by design: one
instance, one identity, and `chmod` changes a mode bit in the virtual
filesystem without enforcing it, since no real user exists underneath.
Nothing stops one agent's `bash` call from reading `/home/<other>`. The
home gives each agent its own subtree as a starting point, and that is what
this backend offers. For a directory backend, where Pi's `NodeExecutionEnv`
would also work with no adapter at all, just-bash earns its place on
sandboxing: a real shell has no wall between an agent's process and the
machine, and just-bash's virtual shell is at least a wall between an
agent's commands and its own mount. `NodeExecutionEnv` cannot serve as the
in-memory default, because it runs against a real directory.

**Every `Bash` instance runs with `javascript: true` and `python: true`, and
no `network` option.** `connect` (§7) passes both flags on every instance it
builds, for both backends. `javascript` turns on `js-exec`, which runs a
script through just-bash's QuickJS sandbox; `python` turns on `python3` and
`python`, CPython compiled to WASM. Neither needs anything from the host:
both engines ship inside just-bash itself. Omitting `network` is what keeps
`curl` and every other network command absent — just-bash makes network
access opt-in, gated behind an allow-list of origins and methods, and this
project passes no such list. §1 calls network access a boundary this
document leaves out; not passing `network` is how that boundary holds today.
An agent connected to a workspace is told this same set in its system
prompt, in `render.ts`'s `WORKSPACE_PARAGRAPH` (§5) — the one prose copy of
what these flags decide, and it has to stay in step with them by hand: the
two live in different files, and nothing checks them against each other.

**The in-memory default holds 128 MB.** `InMemoryFs` takes a byte limit at
construction, and the default backend sets one (`MEMORY_LIMIT_BYTES` in
`just-bash.ts`). A write past it throws `ENOSPC`, which reaches the tool as
a failure that names the limit. A directory backend has no such cap: the
disk under it is the limit.

**`cleanup()` is a no-op.** `ExecutionEnv` requires the method. just-bash
exposes no dispose or close on a `Bash` instance or on its filesystems. A
garbage collector reclaims the memory once `destroyWorkspace` (§2) drops
the references.

**`destroy()` drops the filesystem, or deletes the directory, and neither
backend rebuilds after.** For the in-memory default it releases the
`InMemoryFs`. For a directory backend it removes the root's contents and
leaves the root. Either way `lazyResource`'s `mark()` (above) makes it
permanent: a `connect` or `readFiles()` call reaching the backend directly
after `destroy()` rejects rather than quietly starting over.

---

## 9. The adapter around a Bash instance

**A just-bash-backed `Workspace.env` is an adapter wrapped around a `Bash`
instance.** `ExecutionEnv`'s nineteen members return `Result`s and never
throw. `Bash` exposes `exec`, `readFile`, `writeFile`, `getCwd`, `getEnv`,
and a public `fs: IFileSystem` whose methods throw plain `Error`s. The
adapter maps each member onto `bash.exec` or `bash.fs`, and wraps every
throw into `err(...)`. Some names match across the two (`writeFile`,
`appendFile`, `exists`); the shapes do not. Beyond that method-by-method
mapping, the adapter has these responsibilities:

- **Classify just-bash's thrown errors into `FileErrorCode`s.** `bash.fs`
  throws `Error`s with no `code` property; the code is a prefix on the
  message, and its wording differs between filesystems. Probed prefixes:
  `ENOENT:`, `EISDIR:`, `ENOTDIR:`, `ENOTEMPTY:`, `EEXIST:` (`directory
already exists` on `InMemoryFs`, `file already exists` on `ReadWriteFs`),
  `EACCES:`, `EPERM:`, `EINVAL:`, `EFBIG:`, and `ERR_FS_EISDIR: rm '/d'`
  from `ReadWriteFs` when `rm` meets a non-empty directory without
  `recursive`. A table keyed on a leading `E[A-Z]+:` token misses that last
  one; match the leading identifier up to the colon, underscores included.
  Pi's `write` and `edit` call `env.canonicalPath` through the mutation
  queue, which rethrows unless the code is `not_found` or `not_supported`.
  An adapter that maps every throw to `FileError('unknown', …)` makes both
  tools fail on every new file. This one mapping decides whether the
  built-ins work at all.
- **Call `onStdout` and `onStderr` before the adapter's own `exec` promise
  resolves.** Pi's `bash` tool reads a command's output from those
  callbacks only (`executeShellWithCapture` in
  `harness/utils/shell-output.ts`); it reads the returned `stdout` nowhere.
  That function sets `acceptingOutput = false` on the line after
  `await env.exec(...)` returns, so a chunk delivered after the adapter
  resolves is dropped. just-bash's `exec` has no streaming callback of its
  own (`ExecOptions` carries `env`, `cwd`, `signal`, `stdin`, and nothing
  that fires mid-command), so the adapter awaits `bash.exec`, calls each
  callback once with the captured text, and then resolves. Nothing streams
  live: Pi's `bash` tool fires `onUpdate` once, empty, before the call
  starts, and every later update lands after the command has finished.
- **Create `/tmp` before `createTempFile` and `createTempDir` use it**, and
  give temp names a random component so agents sharing one filesystem
  cannot collide. Pi's `bash` tool spills output past its truncation limit
  to a temp file through `createTempFile` and `appendFile`.
  `bash.fs.appendFile` exists and maps directly.
- **Seed `HOME` into the `Bash` environment at construction, and expand `~`
  in `absolutePath` to that same home.** With `HOME` seeded, a bare `cd`
  and a `~` inside a command land in the agent's home; without it, both
  land at the filesystem root (probed). Pi's `NodeExecutionEnv.absolutePath`
  expands `~` and `~/` with `os.homedir()`; the adapter expands them with
  the home `connect` gave the agent, since `read`, `write`, and `edit` all
  resolve their `path` through `absolutePath`
  (`harness/tools/path-utils.ts`).
- **Map `ShellExecOptions` onto just-bash's `ExecOptions`, and tell the two
  exit-124 paths apart.** `cwd` maps to `cwd`, resolved against `env.cwd`
  first the way `NodeExecutionEnv` resolves it; `env` maps to `env`;
  `abortSignal` maps to `signal`; `inheritEnv` has nothing to inherit, and
  the seeded environment is the whole environment. An aborted `exec`
  returns exit code 124 with `bash: execution aborted` on stderr, and the
  adapter returns `err(ExecutionError('aborted'))` when the caller's signal
  fired. just-bash's instance-wide execution limit (`maxExecutionTimeMs`:
  one hour in the `normal` profile, 30 seconds in `hardened`) returns the
  same code with `exceeded its execution deadline`, and the adapter returns
  `err(ExecutionError('timeout'))` when its own timer fired.
  `ShellExecOptions.timeout` is per call and in seconds; just-bash offers no
  per-call limit, so the adapter builds one from an `AbortController` and a
  timer (`Deadline` in `bash-env.ts`). A call that names no timeout gets 30
  seconds (`DEFAULT_TIMEOUT_SECONDS`). Pi's `bash` tool passes the model's
  `timeout` and nothing when the model gives none, so a command that never
  ends cannot hold an activation open.
- **Implement `listDir` as one `readdir` plus one `lstat` per entry.** Pi's
  `FileInfo` carries `size` and `mtimeMs`. just-bash's optional
  `readdirWithFileTypes` returns names and kinds only, so the per-entry
  call is needed regardless.
- **Map the rest directly.** `readBinaryFile` to `fs.readFileBuffer` (Pi's
  `read` tool reads bytes and detects images itself), `fileInfo` to
  `fs.lstat`, `canonicalPath` to `fs.realpath`, `createDir` to `fs.mkdir`,
  `remove` to `fs.rm`, `renameFile` to `fs.mv`, `exists` to `fs.exists`,
  and `readTextLines` to `fs.readFile` plus a split.

---

## 10. A backend on a real machine

**A backend on a real machine fits the same `WorkspaceBackend` shape and is
expected to do more.** Its `connect` creates a real OS user when one is
absent and returns an `env` whose `exec` runs as that user through a real
user switch. That turns the boundary §8 calls nominal into isolation the
operating system enforces, the same guarantee a multi-user Linux box gives.
Its home is the same `/home/<name>` the just-bash backend uses. A `connect`
here has real waits (`useradd`, a process spawn), which is what the
`signal` argument (§7) is for. Nothing here builds that implementation. It
stays a candidate, work this document does not commit to.

---

## 11. Reminders and tasks

A workspace is where reminders and tasks live, once they exist. Neither is
built. Together they are the second persistent entity kind under §1's
model; the filesystem and shell are the first. What is already true, and
bounds the design:

[`README.md`](../README.md)'s idea section names a timer firing and a task
completing as event sources, entering a session as a message like any
other, on the same terms as a person speaking or arriving. If a reminder or
a task is nothing more than where such an event is scheduled from,
`agent.md` rule 1 covers what happens next — every message activates every
idle agent whose attention is wide enough — and the session side needs
nothing new.

What a workspace adds is the part rule 1 does not cover: somewhere to hold
a reminder between the moment it is set and the moment it fires, attached
to the session it concerns, and durable across a restart the way a
session's record is (`agent.md` §5). That storage belongs to the workspace,
as its own entity kind, and it reaches a tool the same way the filesystem
does: through `ToolContext` (§4), as a second property on `Workspace` (§6).

---

## 12. What is not decided

- **Whether just-bash stays a dependency of `@ambionframework/ambion`, or
  moves behind its own backend package.** It is a dependency today, so the
  in-memory default needs no import. It pulls in sixteen runtime
  dependencies of its own (`quickjs-emscripten`, `sql.js`, `undici`,
  `re2js`, and more) for about 22 MB installed. `connect` returning a plain
  `ExecutionEnv` (§7) is what keeps the split possible: nothing in
  `Workspace`'s shape (§6) requires a caller to import just-bash, only the
  `WorkspaceBackend` their factory function builds does.
- **Whether an agent can name a workspace and decline the built-in
  tools.** §5 binds all four to every connected agent, and an agent that
  wants only its own narrower tools has no way to reach `ctx.workspace()`
  without them.

---

## 13. What proves it

The milestone tests live in
[`workspace.test.ts`](../packages/ambion/test/workspace.test.ts), one per
claim this document makes loudly:

- one handle per name until `destroyWorkspace` frees it, and a second
  destroy does nothing (§2);
- `defineAgent` refusing a custom tool under one of the four built-in
  names, and `startSession` refusing an assistant that names a workspace
  (§3);
- a connected agent's activation holding `read`, `write`, `edit` and
  `bash` beside `say`, and a plain agent holding `say` alone (§5);
- two agents on one workspace sharing every file, each rooted at its own
  home, and a home that does not exist until the agent's first tool asks
  for it (§7, §8);
- two edits to one file in one batch both landing (§5);
- a destroyed workspace failing the next built-in call, resolving
  `undefined` for a custom tool, and leaving the activation running (§2,
  §4);
- `ctx.workspace()` calling `connect` on every call and caching nothing,
  and a `connect` failure surfacing as the tool call's failure (§4, §7);
- the adapter: error classification, `~` expansion, output delivered
  through the callbacks, `cd` lasting one command, abort told apart from
  timeout, temp files under `/tmp`, `listDir` with sizes (§9);
- `directoryBackend` writing through to disk, creating its root, and
  emptying it on destroy — and, once destroyed, refusing a `connect` rather
  than recreating the root (§8);
- `js-exec` and `python3` running inside `bash`, and `curl` absent (§8);
- `memoryBackend`'s `seed` function running once, lazily, before the first
  `connect` or `readFiles()` call, and `readFiles()` reading what it wrote
  and a later write back out, sorted by path (§8);
- `readFiles()` skipping a symlink, dangling or not, instead of failing on
  it (§8);
- a seed that fails once being retried on the next call, and a destroyed
  `memoryBackend` refusing `connect` and `readFiles()` instead of silently
  rebuilding itself (§8);
- `WORKSPACE_PARAGRAPH` in a connected agent's system prompt, and absent
  from a plain agent's (§5).

All in-process, in vitest, on a scripted stream where determinism matters.

**What is built.** `defineWorkspace`, `destroyWorkspace`, `ToolContext`,
the four built-in tools, the just-bash adapter, the in-memory default and
`directoryBackend`. Every `Bash` instance runs with `javascript` and
`python` on and `network` unset (§8). `memoryBackend` takes an optional
`seed` and exposes `readFiles()`, so a host can write and read an in-memory
workspace's files without an agent (§8). A workspace-connected agent's
system prompt states the four tools' reach, `WORKSPACE_PARAGRAPH` in
`render.ts` (§5). `startSession`'s public signature did not change (§3).
`handsFor()` in `session.ts` binds the four built-ins beside what
`toPiTool` (`seat.ts`) already did, and `toPiTool` takes the seat's agent
so it can build a `ToolContext` for a `defineTool`-built tool. No
`defineAgent` call in [`README.md`](../README.md), [`agent.md`](agent.md)
or [`examples/site`](../examples/site) changed: none of those agents uses a
filesystem tool.

**What is not built.** The real-machine backend (§10) stays a candidate,
and reminders and tasks (§11) are specified only as far as where they will
live.
