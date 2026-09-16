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

The host supplies the same catalog on resume. A definition absent from the
recorded catalog can enter the reserve only in a new version 2 composition.
Unknown names fail before the room writes a membership entry.

## Attention

Attention controls which events wake an idle member.

| Attention   | Idle agent wakes for                   |
| ----------- | -------------------------------------- |
| `named`     | A message addressed to the agent       |
| `broadcast` | Any eligible message                   |
| `presence`  | Eligible messages and presence changes |

Omitted attention uses `broadcast`. All agents use the same scale. No agent
has a reserved attention value or special addressability rule.

Attention controls waking. It does not grant authority to commit. The room
checks the activation, lease, recipient, and consumed context for every write.

## Membership operations

An agent activation can use `seat({ name })` and `unseat({ name })`. The room
also exposes `room.seat(name)` and `room.unseat(name)` for the host.

- `seat` accepts a name from the catalog and reserve.
- `unseat` accepts a currently seated agent, including the calling agent.
- An unknown name or a human name is refused.
- A duplicate seating request returns an unchanged result.
- A duplicate seating request writes no journal entry, wake, or acknowledgement.

When an agent leaves, its definition remains available in the reserve. Pending
work for that seat settles according to the room's recorded lease rules. A
later seating creates new work only when the journal derives it.

## Views and resume

`room.participants()` returns current agents and human visitors. Reserve agents
do not appear. Views contain identity, membership status, and attention. They
do not contain executable definitions or authority.

`resumeRoom` receives the complete catalog again. It preserves recorded
membership and attention. Startup seating options do not reset a resumed room.
Version 2 composition entries reject legacy assistant histories. Start a new
journal or perform migration outside Ambion.
