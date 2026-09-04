# Next

The five backlog items to do first, in the order to do them. Each one
makes the ones after it a smaller diff. Numbers refer to
[`backlog.md`](backlog.md).

## 1. One test support module (backlog 13)

**Why first.** Every refactor below changes the runtime's prose or its
call shape, and five copies of the scripted stream each read the prose.
One copy that routes on `model.id` makes the rest of the list safe to do.

**Done when.** `test/support/` holds `scripted`, `byAgent`, `speak`,
`quiet`, `collect`, `enter` and the stub assistant. No test file matches
the system prompt. The four abort behaviours agree.

## 2. Split `session.ts` (backlog 3)

**Why now.** The file grew from 842 to 1063 lines in one change, and the
next two items land in it. Splitting first keeps each of them a local
diff.

**Done, 2026-09-04.** `say` lives in `seat.ts` behind a `SayRoom`
interface. The lock lives in `record.ts`. The roster and the reserve live
in `roster.ts`, the model in `model.ts`, the visit handle in
`presence.ts`, and the public shapes in `types.ts`. `session.ts` holds
compose, commit and route, the hands, and quiescence, at 781 lines. Under
600 needed the quiescence block out, and that block is the room; backlog
21 names the scheduler it becomes when a second writer needs it.

## 3. A `Runtime` value in place of the process globals (backlog 1)

**Why now.** This is the change that decides whether a host can run rooms
hermetically and resume them. Everything a long-horizon deployment needs
starts here.

**Done when.** `startSession`, `readSession` and `defineWorkspace` accept
a runtime that holds the registry, the repo and the environment source.
The module-level `running`, `taken`, `defaultRepo` and `builtinRegistry`
are fields of the default instance. Two hosts in one process run rooms
with the same name and never see each other.

## 4. Bound the record, index the presence (backlog 2)

**Why now.** This is the second half of the long-horizon question. A room
that runs unattended for days must not scan its whole record per message
or render all of it per activation.

**Done when.** `Attendance` updates an index on append and `known()` is
O(1). `RoomView.record` takes a window policy, and the design contract
names the module that owns it.

## 5. Load the provider registry on demand (backlog 4)

**Why now.** Import time and memory are what a host pays before the first
room exists, and the fix is small once the runtime value from item 3
holds the registry.

**Done when.** `import '@ambionframework/ambion'` loads no provider SDK.
The registry is a dynamic import inside the default runtime, or the host
supplies it. Import time drops from about 600 ms to under 50 ms.
