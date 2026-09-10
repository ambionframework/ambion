# Next

The four backlog items to do first, in the order to do them. Each one
makes the ones after it a smaller diff. Numbers refer to
[`backlog.md`](backlog.md).

## 1. Split `session.ts` (backlog 3) — done, with a remainder

`say` lives in `seat.ts` beside the seat's side of the wire. The commit
path lives in `log.ts`. Every fact the room held in memory is a fold in
`fold.ts`, the step it takes is `reconcile.ts`, and what an activation
reads is `view.ts`. The reserve is a fold, so it has no module of its own.
`session.ts` holds compose, route, the seat's three calls and the
reconcile glue. It is over the 600 lines the item asked for;
[`backlog.md`](backlog.md) 3 holds what is left to move.

## 2. A `Runtime` value in place of the process globals (backlog 1) — done

`startSession`, `readSession`, `resumeSession` and `defineWorkspace` take
a runtime that holds the clock, the session opener, the transport, the
model call and the catalog. Two hosts in one process run rooms with the
same name and never see each other, and a second runtime resumes a room
over the log the first one left.

## 3. Bound the record, index the presence (backlog 2)

**Why now.** This is the second half of the long-horizon question. A room
that runs unattended for days must not scan its whole record per message
or render all of it per activation.

**Done when.** The fold advances an index per entry, and `foldRoom` is
O(1) per message. `RoomView.record` takes a window policy, and the design
contract names the module that owns it.

## 4. Load the provider registry on demand (backlog 4)

**Why now.** Import time and memory are what a host pays before the first
room exists, and the fix is small once the runtime value from item 2
holds the registry.

**Done when.** `import '@ambionframework/ambion'` loads no provider SDK.
The registry is a dynamic import inside the default runtime, or the host
supplies it. Import time drops from about 600 ms to under 50 ms.
