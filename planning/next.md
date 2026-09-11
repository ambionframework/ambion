# Next

The four backlog items to do first, in the order to do them. Each one
makes the ones after it a smaller diff. Numbers refer to
[`backlog.md`](backlog.md).

## 1. Split `session.ts` (backlog 3)

**Why first.** The file is 1,438 lines, and the next two items land in it.
Splitting first keeps each of them a local diff.

**What is done.** `say` lives in `seat/hands.ts`. The commit path lives
in `log/log.ts`. The reserve is a fold, so it needs no module. The room
reacts to the log in one place: the log calls `hear` for every entry it
takes, and the room no longer holds a second path for the entries it
wrote itself. Closing an exchange is a commit like any other, so the room
writes one kind of entry and routes it in one place.

**What moved against it.** The close became a message (backlog 44), which
took about 100 lines out of `room/fold.ts` and added about 45 to the
routing and the commit here. The room's own writes are now one path, which
is what makes the split below a smaller diff than it was.

**Done when.** The seat's three calls (`view`, `commit`, `lease`) live in
`answers.ts`, over a narrow interface on the room. `session.ts` holds
compose, route and hear, and stays under 600 lines.

## 2. A `Runtime` value in place of the process globals (backlog 1) — done

`startSession`, `readSession` and `defineWorkspace` take a runtime that
holds the clock, the session opener, the model call and the catalog. The
module-level `running`, `taken`, `defaultRepo` and `builtinRegistry` are
fields of `defaultRuntime`. Two hosts in one process run rooms with the
same name and never see each other.

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
