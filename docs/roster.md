# Roster

**A room fixes executable definitions for one run and changes membership by name.**
Each definition supplies an agent's identity, instructions, model, and tools.
The room captures these fields when it starts.

## Configuration

Supply every ordinary definition at startup or resume. Use `seats` to choose
initial membership and attention.

```ts
const room = await startRoom({
  name: 'site',
  agents: [timeTracker, inspector, quantitySurveyor],
  seats: {
    timeTracker: 'broadcast',
    quantitySurveyor: 'named',
  },
  assistant,
});
```

If `seats` is absent, every supplied ordinary agent starts at
`broadcast`. An empty map starts every ordinary agent in the reserve.
The assistant is a separate optional definition. It does not belong in
`agents`, and its name cannot duplicate an ordinary agent.

An agent in `agents` but absent from `seats` remains available for assistant
selection. The room seats a selected agent with `broadcast` attention.
The assistant can select only a supplied definition.

## Membership operations

**Use names for membership changes.** The room already has each definition,
so seating cannot install executable code during a run.

```ts
await room.seat('inspector');
await room.seat('quantitySurveyor', { attention: 'named' });
await room.unseat('inspector');
```

`seat` rejects an unknown name, the assistant name, and a name that is
already a member. `unseat` rejects a name that is not a current agent member.
A newly seated agent uses `broadcast` when no attention is supplied.

An unseated ordinary agent returns to the reserve. Installing a new executable
definition requires a new room run with an expanded definition set.

## Attention

Attention controls which events wake an idle agent.

| Attention   | Idle agent wakes for                        |
| ----------- | ------------------------------------------- |
| `none`      | no message or presence event                |
| `named`     | a message addressed to the agent            |
| `broadcast` | every eligible room message                 |
| `presence`  | eligible room messages and presence changes |

A directed message wakes its named recipient when that recipient is an
addressable member. A member at `none` cannot receive a directed message.
Attention does not grant permission to contribute. The room validates
the activation lease and the consumed context at commit.

## Reading participants

**Call `participants()` for the combined room view.** It returns agent members
and human visitors with their status, identity, and attention where applicable.
Reserve agents do not appear in this view.

```ts
for (const participant of room.participants()) {
  console.log(participant.name, participant.kind);
}
```

The room snapshot also exposes `participants`. These values are immutable
views. They do not grant authority and do not contain executable definitions.

## Resume

A resumed room receives the complete definition set again.

```ts
const room = await resumeRoom('site', {
  runtime,
  agents: [assistant, timeTracker, inspector, quantitySurveyor],
});
```

Resume validates the recorded catalog and roster before execution starts.
It preserves recorded membership and attention. Extra supplied definitions
join the reserve. Startup `seats` do not reset a resumed room.

The journal records membership changes and presence. A host can rebuild the
roster by replaying those entries. Definition functions and provider bindings
stay with the host.

## Scope and limits

A room has one roster for its run. A process restart does not restore JavaScript
functions from the journal. Supply definitions again and resume the same room.
A name identifies a participant inside the room; it is not an authorization
credential.
