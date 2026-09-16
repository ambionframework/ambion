# Persistent rooms in one Node process

**One service hosts multiple rooms and people.** The `design` and `delivery`
rooms share one runtime and SQLite database. Each room has its own journal,
agent execution, exchanges, and human presence. The same `guide` definition
serves both rooms. Alice and Bob can participate in both at the same time.

[`src/main.ts`](src/main.ts) contains the complete host. It uses Node's HTTP
server and SQLite, with no application framework. Model requests use Pi.

## Run

From the repository root, install and build with Node 26.4 or later:

```sh
pnpm install
pnpm build
cd examples/persistent
export ANTHROPIC_API_KEY=...
pnpm start
```

`start` creates `.data/rooms.db` and refuses an existing data directory.
Use `pnpm resume` for subsequent runs. Both commands accept a data directory
argument. Set `PORT` to change port 3000. Set `AMBION_MODEL` to change
`anthropic/claude-sonnet-5`; supply that provider's credential.

**The HTTP interface represents independent clients.** Run these commands
from another terminal. The first message restores or starts the person's visit.
Each send returns `202` with the exchange's `from` and `owner` before agents finish.

```sh
curl -s localhost:3000/rooms/design/humans/alice \
  -H 'content-type: application/json' \
  -d '{"key":"alice-design-1","text":"Suggest two improvements to our onboarding."}'

curl -s localhost:3000/rooms/delivery/humans/bob \
  -H 'content-type: application/json' \
  -d '{"key":"bob-delivery-1","text":"Suggest a short release checklist."}'

curl -s localhost:3000/rooms/design/humans/bob \
  -H 'content-type: application/json' \
  -d '{"key":"bob-design-1","text":"The onboarding should take under five minutes."}'

curl -s localhost:3000/rooms
curl -s 'localhost:3000/rooms/design/messages?since=0'
```

Messages sent during an open exchange join that exchange. Clients do not
choose a different API for steering. A shared database does not join room histories.

| Request                                | Result                                           |
| -------------------------------------- | ------------------------------------------------ |
| `GET /rooms`                           | Room names and current participants              |
| `POST /rooms/:room/humans/:person`     | Send `{key, text}` and return the exchange ID    |
| `GET /rooms/:room/messages?since=:seq` | Read durable messages after this client's cursor |
| `GET /rooms/:room/exchanges/:from`     | Wait for the fixed discussion of that exchange   |
| `DELETE /rooms/:room/humans/:person`   | Record that the person left this room            |

The configured people are `alice` and `bob`. This local example binds to
loopback and uses names without authentication. A deployed host must map
authenticated clients to allowed rooms and human definitions.

## Restart and reconnect

**Clients save progress; rooms save collaboration facts.** Before sending,
save a room-unique delivery key and its exact payload in client storage.
After acceptance, save `from`. After consuming ordered messages, save the
last consumed `seq` separately for each client and room.

1. Send a message and save the returned `from`.
2. While an agent works, run `kill -KILL <PID>` with the printed Node PID.
3. Run `pnpm resume` against the same directory.
4. Retry the original send with its original key and payload if acceptance was uncertain.
5. Read `/rooms/design/messages?since=<saved-seq>` to recover missed messages.
6. Read `/rooms/design/exchanges/<saved-from>` to wait for the original discussion.

Both rooms resume with the same definitions. Accepted questions and replies
survive. No JavaScript handle or pending HTTP request survives the process.
The original delivery key prevents a duplicate question. `Visit.since` records
human departures; it is not the client's consumption cursor.

**A crash preserves presence and lease history.** A reconnecting send calls
`room.visit` again. A person still recorded as present gets no duplicate arrival.
HTTP request completion or a client disconnect does not mean the person left.
`DELETE` ends that person's visit across clients; client connection tracking
belongs to the application.

The default lease expiry is 60 seconds, with retry backoff after failure.
Recovery can therefore pause before a lost local runner's work continues.
The HTTP server keeps the process alive while room alarms recover work.
Model requests can repeat; accepted messages remain in the journal.

**Ctrl+C deliberately stops both rooms.** It revokes work and records human
departures before closing SQLite. Use `SIGKILL` for the interrupted-work scenario.
One process must own this database. This example provides no supervisor,
automatic room discovery, authentication, or domain resource persistence.

See [deployment and recovery](../../docs/deployment.md) for the full contract.
The [live restart test](../../packages/ambion/test/live/restart.test.ts) checks
a real provider contribution across a process kill and SQLite recovery.
