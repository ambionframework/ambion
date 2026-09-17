# Roster

**A room receives one executable definition for each agent name.** The
definition stays with the host. The journal records the identity and current
membership, so replay does not need executable values.

## Configuration

Pass every definition in `agents`. Use `seats` for initial membership and
attention.

```ts
const room = await startRoom({
  name: 'site',
  agents: [inspector, surveyor, editor],
  summary: 'editor',
  seats: { inspector: 'broadcast' },
});
```

If `seats` is omitted, every catalog agent starts as a member at `broadcast`.
An empty map starts every catalog agent in the reserve. `summary` names one
catalog agent that may receive closing work. It does not create a separate
membership type.

The optional `assistant` property registers an ordinary agent, seats it at
`broadcast`, and selects it as the summary writer. With this property,
`seats: {}` seats only the assistant. Omitted `seats` still seats every catalog
agent at `broadcast`. Explicit seats configure the other agents. See
[Default assistant](assistant.md) for conflicts and the complete shorthand.

On resume, supply definitions for every recorded agent name. Additional
definitions enter the reserve in the new run. Names outside that run's catalog
cannot be seated.

## Attention

Attention controls which events wake an idle member.

| Attention   | Idle agent receives                               |
| ----------- | ------------------------------------------------- |
| `none`      | No ordinary speech; direct deliveries are refused |
| `named`     | Speech addressed to the agent                     |
| `broadcast` | Addressed and undirected speech                   |
| `presence`  | Speech plus presence and membership changes       |

Omitted attention uses `broadcast`. The scale applies to every agent, including
a configured summary writer. Closing assignments have their own authority.

Attention controls waking. It does not grant authority to commit. The room
checks the activation, lease, recipient, and consumed context for every write.

## Membership operations

An agent activation can use `seat({ name })` and `unseat({ name })`. The room
also exposes `room.seat(name)` and `room.unseat(name)` for the host.

- `seat` accepts a name from the catalog and reserve.
- `unseat` accepts a currently seated agent, including the calling agent.
- An unknown name or a human name is refused.
- Agent tool commits return `unchanged` when the requested membership already holds.
- Host `room.seat` / `room.unseat` calls reject an already-satisfied request.
- Neither path writes another membership entry for that request.

When an agent leaves, its definition remains available in the reserve. Pending
work for that seat settles according to the room's recorded lease rules. A
later seating creates new work only when the journal derives it.

## Views and resume

The `participants` field of `await room.read({ messages: false })` contains
current agents and human visitors. Reserve agents
do not appear. Views contain identity, membership status, and attention. They
do not contain executable definitions or authority.

`resumeRoom` receives the complete catalog again. It preserves recorded
membership and attention. Startup seating options do not reset a resumed room.
Version 2 composition entries reject legacy assistant histories. Start a new
journal or perform migration outside Ambion.
