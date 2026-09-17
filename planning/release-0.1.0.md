# Ambion 0.1.0: release scope

Target definition, 2026-09-15. This document describes the proposed release,
including behavior that still needs implementation. [next.md](next.md) owns
the remaining work, design changes, and release evidence.

## Positioning

**Ambion is a collaboration kernel for independently owned agents and the
people they serve.** It gives domain agents a shared journal, rules for
participation, and a reliable boundary for contributing to a conversation.

An agent owns its instructions, model, tools, and domain expertise. A room
lets those agents work together and seat supplied colleagues. An optional
summary lets one configured agent consolidate a closed human exchange.
Applications own their domain data and tool resources.

**The agent is the unit of modularity.** A scheduling agent and an inventory
agent can have different owners, models, tools, and evaluations. Each can
improve independently. Their shared collaboration contract makes their
contributions usable together.

**The journal is the source of active collaboration and its history.** It
records contributions, presence, membership, execution claims, and exchange
boundaries. Pure rules interpret those facts to determine what may happen
next. A host can recover unfinished collaboration by replaying the journal.

This is the central release narrative. The API, examples, storage model, and
deployment documentation must all support it.

## Who it serves

**Use Ambion when several domains must contribute to one ongoing application.**
Examples include coordinating a construction programme, checking a purchasing
decision, or keeping an operational plan consistent across specialist systems.

A question such as “Can we promise a Thursday delivery?” can require several
agents. Inventory checks stock. Scheduling checks capacity. Compliance checks
constraints. Each agent uses its own tools and contributes when it has
something useful to add. The person receives the resulting discussion and,
when appropriate, a summary from the assigned agent.

**Rooms persist across individual questions.** People arrive and leave.
Specialists join and leave the active membership. Later messages can change
an answer that is still being prepared. The room preserves what happened
across these interactions.

The 0.1.0 audience is TypeScript application developers building these
collaborations. They supply application hosting, agent definitions, credentials,
and domain tools. Ambion supplies the collaboration semantics.

## The small conceptual model

| Concept          | Meaning                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| Agent definition | An immutable specification of identity, instructions, model, and tools |
| Room             | Participants collaborating through one ordered journal                 |
| Membership       | An agent's participation and attention within a room                   |
| Visit            | A human's speaking identity and presence lifetime                      |
| Exchange         | An opening message and the discussion it starts                        |
| Activation       | A bounded execution with authority to contribute to the room           |

**Application code mainly works with definitions, rooms, visits, and
exchanges.** Membership changes through room operations. Activation and lease
details belong to the hosting contract.

**A message remains one application operation.** Callers send it without
checking whether an exchange is open or an agent is working. The kernel records
it and delivers context according to participation rules. Activation requests
and steering are execution details; neither introduces another message kind.

```text
person enters a room and sends a message
                  |
                  v
          journal records the message
                  |
                  v
       eligible agents reason and use tools
                  |
                  v
        validated contributions join the journal
                  |
                  v
     remaining discussion work reaches completion
                  |
                  v
       exchange closes; assigned agent may summarize
```

## Differentiated capabilities

**The distinction comes from the combination of guarantees.** These mechanisms
are familiar individually. Ambion applies them consistently to collaboration.

| Capability                             | What it gives the application                                            |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Journal-driven coordination            | Recovery uses the same facts that drive live execution                   |
| Freshness checked at commit            | An agent must reconsider speech when relevant unread context has arrived |
| Attention plus mid-execution steering  | Idle agents activate selectively; active agents receive new context      |
| Silence as a valid result              | A consulted agent can finish without generating an acknowledgement       |
| Completion derived from remaining work | An exchange closes without guessing which speaker will be last           |
| Explicit closing assignment            | An ordinary agent publishes a response for one fixed exchange            |
| Recorded membership and presence       | Participation changes remain ordered and recoverable                     |
| One protocol across hosts              | Process placement can change while collaboration rules stay consistent   |

## Functional scope

### F1. Independently configured agents

**Define agents as values and bind them for one room run.** Definitions
contain public identity, private instructions, a model choice, and typed tools.
Reuse a definition across rooms without sharing room membership or execution
state accidentally.

The complete set of executable definitions is supplied at startup or resume.
Membership can change during the run. Installing a previously unknown
definition requires a new run with an expanded set of definitions.

An ordinary agent can receive an optional closing assignment by name. It keeps
its instructions, domain tools, and ordinary membership. Closing execution
receives bounded context and the regular `say` tool. No separate agent role or
generic role registry is required.

### F2. Shared rooms, participation, and presence

**Give each room one ordered collaboration record.** Support multiple agent
members and human visitors. Record speech, arrivals, departures, membership
changes, and summaries with their provenance.

Support broadcast messages and messages addressed to a participant by name.
Attention controls what activates an idle agent: direct messages, room speech,
or presence changes. Keep this policy separate from execution activity.

Hosts supply all executable definitions in `agents`. The optional `seats` map
sets initial members and attention. If omitted, every definition starts at
`broadcast`; an empty map places every definition in the reserve. Every
participating agent can seat or unseat catalog colleagues. Empty rooms are
valid. Agent work requires a seated agent whose attention accepts the message.

People have identities and optional response preferences. A visit determines
who speaks and when that person is present. Preferences shape the assigned
agent's closing response. Summaries shaped for people also compact later
activation context. The original discussion remains available for human review.

### F3. Concurrent, current contributions

**Let agents reason concurrently and serialize their accepted contributions.**
Ordinary speech carries an acknowledgement of the context consumed. If the
room advanced beyond that context, the room refuses the stale contribution
and supplies the missing context for reconsideration.

New messages can steer active ordinary agents between provider requests.
Rendering or queuing a message does not acknowledge it. Lease renewal extends
execution authority without implying that the agent read new context.

An agent may finish silently. Model failures, retries, and exhausted attempts
remain distinguishable from deliberate silence in host diagnostics.

Domain tools may run before a contribution commits. Conversation freshness
does not make those external effects transactional.

### F4. Exchanges and optional closing assignments

**Provide durable handles for a discussion and its response.** One room has
one open discussion at a time, with an owner established by its opening
message. Further messages can affect that discussion. Separate simultaneous
discussions use separate rooms.

The exchange closes when its required discussion work has finished or reached
the applicable terminal state. A recorded close fixes its range. Closing
certifies the discussion boundary, not the correctness of every answer.

Agents can seat reserve specialists during ordinary discussion. Every closed
human exchange is eligible for a summary when `summary` names a seated agent.
That assigned agent can publish one summary for the owner through `say`. The
room supplies the recipient and covered range. The summary retains its source
range even if a later exchange starts. The writer may decline.

**Closing work has explicit publication rules.** Its publication wakes no idle
agents and does not hold another exchange open. It retains an internal summary
event for context replacement and response completion. The assigned agent can
also participate in ordinary discussion under its configured attention.
Closing execution uses only the regular `say` tool. Ordinary activations use
`say`, `seat`, `unseat`, and their domain tools.

`exchange.waitForClose()` waits for the fixed discussion. `exchange.waitForSummary()`
waits for its summary or a terminal result without one. An application can
always use the discussion when no summary is available.

**Use summaries in later activations and retain the discussion for human
review.** Once a closed exchange has a summary, agent context uses it in place
of the covered source messages. Agents continue from the summary and their
domain tools. Human participants can review the original discussion through
`exchange.waitForClose()`. The journal retains every source message for review and
recovery. Closure without a summary does not itself replace source messages.

### F5. Persistence and recovery

**Recover room state and pending work from confirmed journal entries.**
Support idempotent delivery keys, conditional appends, writer fencing,
lease-based execution, and bounded retry attempts with configured backoff.

A lost acknowledgement can be retried under the same delivery key. A resumed
host reconstructs membership, exchange boundaries, and pending work. A stale
writer cannot continue committing as the current room owner.

Read a stored room without starting agents. Reacquire an exchange by its
opening position. Keep room history and Pi audit transcripts in separate
named journals, even when they share one database.

Composition entries use version 2. The room rejects legacy assistant
compositions and opening activation ids. Start a new journal or migrate old
history outside Ambion before resuming it.

An audit persistence failure must not, by itself, repeat successful model
execution. Confirmed audit data remains available; unconfirmed audit data may
be lost on process failure. Room contributions retain their own durability.

### F6. Typed tools and workspace resources

**Give each agent explicit tools and resource access.** Tools receive typed
parameters, caller context, and cancellation information. Tool bundles combine
tools and guidance without owning a separate lifecycle.

Provide optional workspace resources with in-memory and directory-backed
filesystems through just-bash. A workspace owns connection, complete-operation
serialization, disposal, and destruction. Several agents can share one
workspace when the application intends that sharing.

Workspace data remains separate from collaboration history. The default
workspace does not provide operating-system isolation between agents or
distributed ownership of a shared directory. Hosts own credentials and
authorization for external services.

### F7. Observation and control

**Expose facts for product interfaces and diagnostics for operators.** Read
messages, participants, and exchange results. Let human participants review
an exchange's original discussion even after its summary compacts agent context.
Subscribe to live host events for contributions, activation activity, conflicts, and failures.

Support leaving a visit, changing agent membership, aborting room work, and
stopping a room. Document the room-wide scope of abort and stop. A single
exchange handle does not imply independent cancellation of its agents.

Subscriptions belong to a running host. After reconnecting, clients read
durable messages and reacquire exchange handles. A durable cross-process
subscription service is outside this release.

### F8. Deployment models

**Separate deployment topology from persistence and tool resources.** The
same collaboration rules serve the following models, with explicit support
levels for 0.1.0.

| Model                         | Room and execution placement                                      | Persistence                                 | 0.1.0 support                                                                 |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Embedded Node application     | Room and agent runners in one process                             | In-memory journals                          | Supported for development, tests, and ephemeral application lifetimes         |
| Persistent Node service       | Room and agent runners in an application-managed service          | SQLite journals through the storage adapter | Supported, with documented restart and recovery procedures                    |
| Separate room and agent hosts | Room calls and executor calls cross the JSON protocol             | Storage chosen by each host                 | Extension contract, validated by the Cloudflare reference implementation      |
| Cloudflare Durable Objects    | One object per room and one per seat; RPC and alarms connect them | Each object's SQLite storage                | Publishable adapter used by the local CLI; deployment commands remain pending |

**The embedded model requires no remote coordination service.** The host
supplies model credentials and keeps the process alive while work runs.
In-memory state lasts only for the storage instance's lifetime.

**The persistent service owns its operational lifecycle.** Supply the agent
definitions again after restart. Resume the existing room against the same
storage. Use one authoritative writer per room and handle supersession.
Persisted history alone does not restart a stopped application process.

**Separated execution keeps code beside the executor.** Deploy tool functions,
model access, credentials, and workspace clients to their execution hosts.
The protocol carries collaboration data and identities; it does not deploy
JavaScript definitions or establish a network authentication system.

The Cloudflare reference proves serialization, alarms, and recovery through
workerd tests. Publishing it as a supported deployment requires separate
packaging, configuration, operations documentation, and deployment evidence.
The Node directory workspace is not automatically available in a Durable
Object.

Browser-only execution, a managed service, arbitrary edge-platform support,
and turnkey deployment commands are outside 0.1.0.

### F9. Distribution and developer experience

**Ship a usable TypeScript library with a short path to a working room.**
Provide ESM packages, declarations, accurate package READMEs, and examples
checked against the packed release artifacts. The Node target remains
22.19 or later, subject to the tested compatibility matrix.

The release packages are `@ambionframework/ambion`,
`@ambionframework/journal`, `@ambionframework/pi-journal`, and
`@ambionframework/workspace`, `@ambionframework/cloudflare`, and
`@ambionframework/cli`. The main library composes the defaults;
applications import additional packages only when they need those capabilities.

Pi remains the supported model loop. Provider selection follows the installed
Pi integration. A provider-neutral plugin ecosystem is outside this release.

Keep the configured GitHub Packages distribution and document its read-token
requirement. A registry change requires an explicit distribution decision.
Publish the implemented local CLI and Cloudflare adapter together.
`ambion new` is the only project-creation command. Deployment commands remain
separate from this local development release.

## Boundaries and limits

**Document the limits alongside the capabilities.**

- Full history remains in storage and replay. Memory and model input can grow
  with room history; 0.1.0 does not promise bounded context or indefinite scale.
- Activation deadlines and retry caps do not impose a total exchange budget.
  Continuing contributions can keep an exchange open.
- Leases fence room contributions. Tools can repeat after failure or continue
  briefly after cancellation; applications own effect idempotency.
- A process crash does not record a person's departure. Hosts reconcile
  durable presence with their actual connections after recovery.
- Recovery must distinguish a dead local runner from a remote runner that
  still holds authority. Host topology and lease expiry affect recovery time.
- The journal is not a task database, credential service, or domain transaction
  coordinator. Separate rooms do not share an atomic transaction.
- Ambient means a room remains available between interactions. Native timers,
  external event subscriptions, and a scheduler ingress API are future work.

## What makes this release complete

**A user can understand the model and rely on its stated guarantees.** A
small example demonstrates specialist collaboration, optional synthesis,
silence, and a late contribution. Its persistent variant demonstrates restart
without losing accepted contributions or pending work.

The supported deployment models pass their required tests. Packed packages
install and compile in a clean consumer. Documentation distinguishes current
capabilities, deployment responsibilities, and limitations without promising
future features.

Implementation choices and completion tracking belong exclusively in
[next.md](next.md).
