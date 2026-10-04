# Roster

**A room receives one executable definition for each agent name.** The
definition stays with the host. The journal records the identity and current
roster, so replay does not need executable values.

## Configuration

Pass every definition in `agents`. Use `seats` for initial seating and
attention.

```ts
const room = await startRoom({
  name: 'site',
  agents: [inspector, surveyor, editor],
  summaryWriter: 'editor',
  seats: { inspector: 'broadcast' },
});
```

**The default seating puts every defined agent at `broadcast`.** If `seats`
is omitted, every defined agent starts seated at `broadcast`.
An empty map starts every defined agent in the reserve. `summaryWriter` names one
defined agent that may receive closing work. It does not create a separate
seating type. `summaryWriter` must name an agent in `seats`. A room start
rejects a `summaryWriter` name that is not seated.

A `seats` entry takes an attention value, or a `SeatOptions` object with
`attention` and `fixed`. Use the object form to set `fixed` at start:

```ts
seats: { editor: { attention: 'broadcast', fixed: true } }
```

The optional `assistant` property registers an ordinary agent as the
summary writer. [Default assistant](assistant.md) states how it changes the
seats, its conflicts, and the complete shorthand.

On resume, supply definitions for every recorded agent name. Additional
definitions enter the reserve in the new run. Names outside that run's definitions
cannot be seated.

## Attention

Attention controls which events wake an idle seat.

| Attention   | Idle agent receives                               |
| ----------- | ------------------------------------------------- |
| `none`      | No ordinary speech; direct deliveries are refused |
| `named`     | Speech addressed to the agent                     |
| `broadcast` | Addressed and undirected speech                   |
| `presence`  | Speech plus presence and seating changes          |

Omitted attention uses `broadcast`. The scale applies to every agent, including
a configured summary writer. Summary activations have their own authority.

Attention controls waking. It does not grant authority to commit. The room
checks the activation, lease, recipient, and consumed context for every write.

## Seating operations

An agent activation can use `seat({ name })` and `unseat({ name })`. The room
also exposes `room.seat(name, options?)` and `room.unseat(name)` for the host.

- An activation holds `seat` only when the reserve held an agent as the room
  composed. The tool list of a seat then stays the same for the whole room,
  so a harness keeps its session and its prompt cache. After the reserve
  empties, `seat` refuses with "The reserve is empty." A room composed with
  an empty reserve never offers `seat` to an agent. The host seats with
  `room.seat`.
- The prompt shows the reserve of the moment, and shows no block when the
  reserve is empty.
- `seat` accepts a name from the definitions or the reserve.
- `unseat` accepts a currently seated agent, including the calling agent.
- An unknown name or a person name is refused.
- Agent tool commits return `unchanged` when the requested seating already holds.
- A host `room.seat` / `room.unseat` call that repeats an already-satisfied
  request resolves without writing a new entry. A host `seat` that asks for
  other attention or fixing than the held seat has is refused.
- Neither path writes another entry for that request.
- An unseating drops the scheduled says of that seat
  ([Exchange](exchange.md#6-a-scheduled-say)). A seating again does not bring
  them back.

## Turn off seating for agents

**`seating: false` removes seating from the agents of a room.** Pass it to
`startRoom`. The default is `true`.

```ts
const room = await startRoom({ name: 'site', agents: [inspector, surveyor], seating: false });
```

- No activation holds `seat` or `unseat`, and the prompt shows no reserve.
- The room refuses a `seated` or an `unseated` intent from a seat with
  `This room does not let agents seat or unseat agents. Only the host can.`
- `room.seat` and `room.unseat` work as before.
- The composition entry records `seating: false`. A default room writes no
  `seating` field, and a missing field reads as `true`. A resumed room keeps
  the recorded value.
- The composition entry records `reserved: true` when the reserve held an
  agent. A resumed room keeps the value, and records it when a new
  definition joins the reserve.
- A `compose` call cannot bind `seat` or `unseat`. See
  [Compose](compose.md#what-a-compose-call-binds).

## Fixed seats

A seat can be fixed: an agent cannot unseat it through the room's `unseat`
tool, though the host always can through `room.unseat`. A seating is fixed
when its `SeatOptions` set `fixed: true`, or, absent that option, when the
seat is the room's configured summary writer. Set `fixed: false` on the
summary writer's seat to let an agent unseat it.

A fixed seat still leaves through the ordinary channel when the host removes
it. The room does not otherwise protect a fixed seat from crashes or replay.

When an agent leaves, its definition remains available in the reserve. Pending
work for that seat settles according to the room's recorded lease rules. A
later seating creates new work only when the journal derives it.

## Views and resume

The `participants` field of `await room.read({ messages: false })` contains
current agents and people. Reserve agents
do not appear. Views contain identity, seating status, and attention. They
do not contain executable definitions or authority.

`resumeRoom` receives the complete definitions again. It preserves the recorded
roster and attention. Startup seating options do not reset a resumed room.
