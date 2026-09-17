# Tasks

**Tasks and subscriptions provide parallel work within an exchange.** Read
[agent.md](agent.md) and [exchange.md](exchange.md) for the core runtime
contracts.

## Task, working room, and subscription

**A Task records a goal, status, and history of work.** An agent creates a
Task and selects or defines a working room to carry it out. The Task is
attached to that room and can appear as a pinned item.

**A working room can have many attached Tasks.** Each Task has one working
room, its own goal, status, owner, and subscriptions. Tasks that share a
working room belong to the same owning exchange and share its conversation.

**The working room knows its attached Tasks and publishes Task events.** Its
agents perform the work, report progress, and declare success or failure.
The room needs no knowledge of its parent, owner subscriptions, or notification
recipients. It does not send reports directly to a parent room.

**Subscriptions deliver Task events to interested agents.** The creating
agent becomes the Task owner and subscribes from the originating room.
Notifications arrive as ordinary messages in the exchange. They steer an
active activation or reactivate an idle seat. The owner decides whether an
update needs further instructions.

**Agent identity is reusable across rooms.** The same agent can work in the
originating room and several working rooms concurrently. Each room keeps one
ordinary activation per agent seat. Subscription delivery must reach that seat
even when the event author has the same agent name in another room.

For example, a purchasing agent creates Tasks to check two suppliers. Each
working room includes purchasing and logistics agents. Both rooms publish
Task updates while the originating room considers the budget.

## Records and authority

**The Task retains its origin and execution relationships.** The runtime uses
these records to enforce authority, recover work, and determine exchange
completion:

| Field            | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| Identity         | A stable reference to the Task                                    |
| Assignment       | Text with the goal, constraints, and starting context             |
| Owner            | The agent that creates the Task and handles intervention requests |
| Originating room | The parent room from which the agent creates the Task             |
| Owning exchange  | The exchange that contains the Task's lifetime                    |
| Working room     | The room selected or assembled to work on the Task                |
| Status           | Open, succeeded, or failed                                        |
| Outcome          | The result on success, or the reason for failure                  |
| Events           | Ordered updates, transitions, and working-room idle events        |

Each event records its identity, Task, author or runtime cause, and source
room. Final outcomes retain links to the working discussion for historical
review. The working room receives the ID, assignment, and status of each
attached Task. Tools and instructions carry explicit Task IDs so agents can
distinguish assignments in the shared conversation. The room does not need
the originating room's conversation or routing relationships.

**A subscription records a Task, destination, and selected event types.** The
destination identifies an agent in a room. Creation automatically subscribes
the owner to state transitions and working-room idle events. Progress updates
are optional, disabled by default, and controlled by framework configuration.
Creation records the subscription before delivering the Task assignment, so
early events cannot be lost.

Set `createRuntime({ tasks: { progress: true } })` to deliver progress updates.
The Cloudflare adapter accepts the same `tasks` option in `configure()`.
The default delivers terminal transitions and idle events only.

Other observers can use the same subscription mechanism later. A subscription
grants notification delivery only. It does not grant authority to steer or
change Task state. Subscription removal cannot detach a Task from its owning
exchange.

**Working agents can update attached Tasks and execute transitions.**
The owner can also update or settle its Task from the originating room when
intervention is needed. Additional steering comes from the owner. Other
participants direct proposed changes through the owner.

The initial transitions are `open → succeeded` and `open → failed`. A progress
update leaves the status open. A terminal state is final; further instructions
require a new Task. Success does not require a separate owner approval.

## Tools

**Two Task tools and the existing `say()` tool cover the workflow.** The
tools derive authority and provenance from the calling activation.
Subscriptions are automatic. Attention and notification
preferences belong to framework configuration. No dedicated Task read tool
is needed.

### Create and subscribe

**`task()` creates a Task and owner subscription in a new or existing working
room.** For a new room, the agent selects participants from the available
catalog. One `text` field contains the goal, success criteria, constraints,
and starting context. The assignment enters the selected room as a message.

```ts
task({
  text: 'Confirm Tuesday delivery for eight units from supplier A within $2,000.',
  agents: ['purchasing', 'logistics'],
});
// Returns { task: 'task-123', room: 'room-456', status: 'open' }.

// Attach another Task to the same working room.
task({
  text: 'Confirm the return deadline and restocking fee for supplier A.',
  room: 'room-456',
});
```

Creation requires exactly one of `agents` or `room`. A nonempty `agents`
list selects participants for a new room. A `room` ID selects an existing
working room. Reusing a room preserves its participants and discussion. The
runtime validates attachment authority and requires the same owning exchange.
A room can receive another Task after earlier Tasks finish, while that
exchange remains open.

The runtime binds the subscription destination to the creating agent's seat.
The tool exposes no subscription options. Required owner notifications cannot
be disabled.

The runtime records the Task's originating room and owning exchange from the
calling activation. A new assignment steers active seats or wakes eligible
idle seats in the working room. Pinning displays assignments without a
separate tool operation.

Tasks run in their working rooms in the background. The owner can continue
engaging the originating room while a Task runs, including when the same agent
has an independent activation in the working room. Task context in an ordinary
owner activation includes only that owner's Tasks from the current exchange;
an owner does not see Tasks from earlier exchanges or Tasks owned by another
agent. A summary activation likewise sees only its writer's Tasks from the
exchange it summarizes. A working-room activation sees every Task attached to that room so
shared work can account for each status. An empty selection is represented by
`tasks: []`, allowing every activation to reason about the absence of its own
Tasks without inheriting unrelated history.

The call returns after recording creation, without waiting for completion.
Separate subscription-management tools are outside the initial scope.

### Publish an update or transition

**`task_update()` records progress or changes Task state.** Working agents
publish to the Task without specifying notification recipients. Every update
requires `task` and `text`. The optional `status` declares a terminal outcome.

```ts
// Progress: the Task remains open.
task_update({ task: 'task-123', text: 'Supplier A is checking the delivery slot.' });

// Success: text states the result and supporting evidence.
task_update({
  task: 'task-123',
  status: 'succeeded',
  text: 'Eight units confirmed for Tuesday at $1,850.',
});

// Failure: text explains why the Task could not complete.
task_update({
  task: 'task-123',
  status: 'failed',
  text: 'No delivery meets the deadline.',
});
```

Omitting `status` records progress and leaves the Task open. When supplied,
`status` must be `succeeded` or `failed`. Text carries the update, result, or
failure reason without separate fields. Task IDs remain explicit because a
room can hold several Tasks.

The runtime checks Task authority and consumed context before accepting a
transition. It records the event and schedules delivery to matching
subscriptions.

**Settlement informs the working room and preserves shared execution.** A
terminal transition enters the working room's context as well as matching
subscriptions. It prevents further updates or instructions for that Task.
It does not stop shared activations or settle other Tasks in the room.
Working agents stop pursuing the final Task when they consume the transition
and can continue on the remaining assignments.

Already-running domain tools follow their existing cancellation semantics.
Selective cancellation of one Task's tool calls is outside the initial scope.
The exchange waits for remaining room execution even when all Tasks are final.

Updates include the evidence and limitations needed by subscribers. The
owner requests missing information through Task-directed `say()` messages.
Subscriber context includes the assignment, status, event, and relevant Task
correspondence. Subscribers do not need to read the working room's full
discussion.

### Steer the working room

**`say()` can address an open Task.** The owner can ask a question, supply
missing information, or redirect work through the existing message tool.

```ts
say({ task: 'task-123', text: 'Delivery must arrive before noon.' });
```

The `task` destination and existing participant destination `to` are mutually
exclusive. Omitting both retains ordinary room speech. The runtime checks
the owner's steering authority and resolves the working room from the Task
record. Instructions enter normal room routing and steer or wake eligible
seats. Working agents answer by publishing Task updates. Parent messages are
not automatically forwarded.

## Idle notifications and intervention

**An idle working room with an open Task requests owner intervention.** The
runtime records an idle event for each open Task when the room has no active
agents or pending execution. Each owner subscription delivers its Task's
current state and latest updates, asking the owner to determine the next
action. Completed Tasks do not receive idle events.

The owner can provide information, redirect the working room, or declare the
Task succeeded or failed. Replying can restart working-room execution. An
idle event does not itself establish success or failure.

**Idle notifications describe a change in execution state.** Delivery and
replay must not repeatedly notify an owner for the same Task and idle period.
If owner steering starts new work, a later idle state can produce another
event. An idle notification that is still pending must prevent exchange
closure before the owner has a chance to act.

The runtime must distinguish an idle Task from one whose terminal transition
already settled its work. A final Task does not request further intervention.

**The owner receives one actionable opportunity per idle event.** The runtime
records which activation consumes the notification. Delivery alone does not
count as consumption. After consuming it, the owner must either send
instructions that schedule further work or declare the Task succeeded or
failed.

When that activation finishes successfully, the runtime checks the Task and
idle event against current recorded state. If the Task remains open in the
same idle period, with no pending work or resolving action, the runtime records
failure:
“Owner did not resolve the intervention request.” A progress update alone
does not resolve the request.

**New work or settlement makes an old idle check inapplicable.** The check is
tied to a specific Task and idle event. A new period of working-room activity
invalidates the previous idle check, even if the room becomes idle again
before the owner's activation ends. A later idle event has its own
intervention obligation.

Normal activation recovery handles execution failure. The runtime does not
send repeated model reminders or introduce timers solely to resolve ignored
intervention requests. If recovery is exhausted, the failure rules below
settle the affected Tasks.

## Exchange activity and completion

**An exchange stays active while agents work in any of its rooms.** Activity
includes the originating room and every working room associated with Tasks
in that exchange. Pending execution, Task creation, and subscription deliveries
also count as outstanding work. Moving work between rooms must not create a
false interval of quiescence.

A shared working room contributes its activity once, regardless of its Task
count. Task settlement is independent: every attached Task must reach a final
state. Completing one Task does not end the room's other work.

For example, an idle originating room remains part of an active exchange
while a working room runs. When that room becomes idle with an open Task,
the pending notification continues the work in the owner seat. A reply can
then continue work in the working room.

**Every Task must reach a final state before the exchange closes.** Idle
notifications provide the normal path for resolving unfinished Tasks. An open
Task with no executing agents requires intervention; silence cannot discard
it at the exchange boundary.

Execution, delivery, and intervention obligations all prevent closure until
they settle. An ignored intervention request follows the runtime failure rule
above. The runtime must not continuously reactivate the owner for the same
unchanged idle state.

Working rooms have no independent exchange lifetime. A later exchange can
reference completed Task history but cannot inherit outstanding Task work.
Closing summary activations run after settlement and cannot create or steer
Tasks.

## Journal authority and delivery

**The owning exchange's room journal is the authority for Task state.** It
serializes creation, updates, transitions, instructions, and subscription
obligations. Working rooms submit operations through the runtime. They do not
need to know which room hosts that authority.

**Each working room has a separate journal in the originating runtime.** The
Cloudflare adapter hosts these journals in the originating room object.
Each working seat retains its own room identity and seat object. The host
multiplexes room timers onto the object's native alarm.

A working room records an accepted operation while its calling lease is live.
The originating journal then checks the Task version and records the event.
Source receipts and destination acknowledgements survive recovery. Operation
identities include the source room, activation, and tool call.

The executor includes fresh Task context in tool results. It acknowledges
that context only when a provider request consumes the result. Working-agent
context omits the originating room and subscription routes.

1. Record Task creation and its owner subscription before dispatching the
   assignment or starting a new working room.
2. Record each event together with its delivery obligations.
3. Deliver recorded assignments, instructions, and notifications with stable
   identities. Retry delivery without creating duplicate work.
4. Record delivery acknowledgements so recovery can find unfinished delivery.
5. Settle execution, delivery, and intervention obligations before recording
   exchange closure.

**The first valid terminal transition determines the outcome.** Later
conflicting transitions are refused and return the recorded final state.
Retrying an already accepted operation returns its original result. A stale
decision is refused with newer Task context so the agent can reconsider it.

Execution bindings track the Task context an activation has consumed. The
runtime checks that context at the authoritative commit boundary. Updates,
instructions, and transitions share this ordering, including operations that
arrive while an owner decides how to respond.

**Final state remains authoritative during delayed delivery.** Late updates
or instructions cannot change or reopen a final Task. Notifications for
already accepted events retain their identity and order at each destination.
Historical progress must not overwrite newer Task state in agent context.

Idle events identify both the Task and the working room's idle period.
Recovery reconstructs their delivery and consumption before evaluating owner
inaction. An interrupted delivery cannot consume the owner's opportunity.

## Failure and recovery

**Execution responsibility determines Task failure.** A subscriber's failed
activation does not fail a Task while its working room can still complete it.
Working-room failures produce Task events. Recoverable execution and delivery
failures follow the retry policy.

When a Task cannot proceed and its owner cannot handle the required
intervention after recovery is exhausted, the runtime records Task failure.
The event identifies the execution failure and runtime authority. The runtime
cannot declare success.

An owner that has lost membership cannot receive intervention. If the Task's
working room has no remaining execution or pending work, the runtime records
failure with that reason. Owner unavailability does not fail Tasks whose
working rooms can still complete them.

Cancellation or terminal failure of the owning exchange fails outstanding
Tasks and stops their working execution before closure. Task failure alone
does not require the exchange to fail. Pending terminal notifications must
settle through delivery or a recorded terminal delivery failure.

**Task events and subscriptions are durable.** Recovery must reconstruct Task
state, working-room activity, and undelivered notifications. Retried tool
calls and redelivered events must not duplicate Tasks, updates, transitions,
or owner activations. A final Task cannot reopen after restart.

## Initial scope

**The first implementation supports multiple Tasks per working room within
one exchange.** Only agents acting in the originating room can create Tasks.
Working rooms cannot create nested Tasks. Subscription-management tools and
selective cancellation of Task tool calls are deferred.

The initial mechanism provides parallelism within an exchange. Persistent
backlogs and Tasks that remain outstanding across exchanges are outside this
mechanism.

## Implementation and verification

**Deterministic tests cover the complete execution path.** They create Tasks,
execute assignments, deliver updates, settle outcomes, and close exchanges.
Additional tests cover shared rooms, authority, idle intervention, and recovery.
The Cloudflare tests exercise remote seats and room-object eviction.

The verification contract includes these behaviors:

- Creation accepts exactly one of `agents` or `room` and automatically records
  the owner subscription before assignment delivery.
- Updates use one text field, and an omitted status leaves the Task open.
- Task-directed `say()` checks owner authority and refuses a simultaneous
  participant destination.
- An owner that consumes an idle notification and takes no resolving action
  causes failure only for Tasks still covered by that idle event.
- A new working period or concurrent settlement invalidates an old idle check.
- Competing terminal transitions produce one outcome; retries return the
  original result, and stale decisions receive newer context.
- Completing one Task updates working agents without interrupting another
  Task's shared activation.
- Exchange closure waits for remaining execution and delivery even when all
  Tasks have final states.
- Interruptions during creation or delivery recover without lost assignments,
  duplicate Tasks, duplicate notifications, or a false interval of quiescence.
- A notification reaches the owner when the author has the same agent name
  in another room.
- Owner recovery exhaustion or lost membership settles required intervention
  without failing Tasks whose working rooms can still complete them.
