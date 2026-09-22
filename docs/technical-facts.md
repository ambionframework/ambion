# Technical facts

This page holds the key technical facts of Ambion, what is new, the packages, and the
limits of the 0.1.0 release. The [README](../README.md) holds the positioning.

## Key technical facts

- **One append-only journal per room.** Messages, arrivals, departures,
  seatings, leases, closes, references, and the composition are entries under
  one sequence. Every room fact is a pure fold over those entries. A resume
  is a replay. See [Durability](durability.md).
- **Conditional, fenced, idempotent writes.** Storage appends only at the
  expected position. Each run writes a fence, and a later fence voids the
  earlier run's writes. A retry under the same key lands once. Golden
  journals of format 1 replay in CI, and before 1.0.0 the format may change
  in any release. Memory and SQLite storages ship, with a Cloudflare Durable
  Objects adapter.
- **Derived activation identity.** An activation id encodes its cause, its
  journal position, its seat, and its attempt. Nothing mints an id, so a wake
  can be sent twice and the fold refuses a stale caller. Leases claim, renew,
  expire, and end with a recorded reason and the activation's usage.
- **Freshness checked at commit.** A `say` carries the position its
  activation read. If the record moved, the room refuses it and returns the
  missed messages. An active agent receives new context between provider
  requests when its framework takes a message during a run, and on its next
  pass otherwise. See [Agents](agent.md).
- **The exchange is a fold.** The first human question after the last close
  opens it. Quiescence closes it with an outcome: complete, cancelled,
  exhausted, or awaiting a person. One configured writer may publish one
  summary for each person who spoke, with a stamped recipient and range.
  Later prompts read the summary in place of the covered messages while the
  source stays readable. See [Exchanges](exchange.md) and
  [Summaries](summary.md).
- **One executor contract.** The kernel drives leases, passes, steering, and
  freshness. A framework supplies one session with passes. Pi, the Claude
  Agent SDK, and the Codex SDK ship as adapters. Codex reaches the same
  three room tools through an MCP server. A conformance suite proves the Pi
  and Claude adapters on fakes. The Codex adapter runs live.
- **Speech through `say` only; everything else into a trace.** Every
  activation writes its steps live to its own trace: thinking, text, tool
  calls, room calls, steers, approvals, and usage. `readActivation` returns
  them by pass, and `subscribe` streams them with an activation id.
- **Artifacts by reference.** A message and a summary carry `refs`, URIs the
  kernel validates, stores, and renders, and never reads behind. Rooms and
  exchanges have URIs. Every resource change carries the activation, the
  exchange, and the room that made it. See [Resources](resources.md).
- **The workspace mirrors the collaboration onto itself.** An audit log
  records every tool call the workspace served, as one JSON line: the room,
  the agent, the tool, the arguments, and the result. A room mirror copies
  its own messages to one file per room. Both rotate the same way, and both
  read like any file an agent already reads. See [Workspace](workspace.md).
- **Three JSON calls each way.** A seat calls `view`, `commit`, and `lease`.
  The room calls `wake`, `steer`, and `cut`. In-process and RPC transports
  share the rules. See [Deployment](deployment.md).
- **Correctness as evidence.** Pure rules carry Dafny-verified contracts. A
  scripted suite runs on memory and SQLite, a chaos sweep crashes before and
  after every append, and a process-kill test resumes over the same
  database.

## What is new

- **No scheduler and no task database.** Retries, resends, backoff, and
  completion derive from the journal, so recovery and live execution use the
  same facts.
- **A say lock for conversation.** Optimistic concurrency applied to speech,
  with the delta returned on refusal, lets agents reason in parallel and
  serializes what they accept.
- **Silence and quiescence as results.** An agent can finish without a mark,
  and an exchange closes when no work remains.
- **Compaction shared by humans and agents.** The summary written for a
  person is the context later agents read.
- **Routing stored with the message.** The attention scale decides who
  wakes, and the decision is written on the entry, so replay routes the same
  way.
- **Any framework, one adapter each.** A definition is a name, an identity,
  and an executor. The kernel keeps the leases, the passes, and the freshness
  check; a framework supplies one session with passes.
- **The trace beside the record.** Harness output maps to one step
  vocabulary, written live per activation, so a person drills from a room to
  an exchange to an activation to a step, with usage and cost on every
  activation.
- **Artifacts by reference.** Files and tables are the medium. The record
  names them, and the kernel reads none of them.
- **The workspace audits and mirrors the room.** A rotating log records
  every tool call the workspace served. A room mirror copies its own
  messages to a file the room never sees. An agent reads either one the
  way it reads any artifact.
- **Waiting on a person as a derived outcome.** An exchange whose last word
  is a question to a person reads as awaiting them, which gives approval a
  representation with no new entry kind.

## Packages

| Package                       | Concern                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`     | The kernel: protocol, journal vocabulary, rules, room, driver; `/hosting`, `/testing` |
| `@ambionframework/pi`         | The Pi executor                                                                       |
| `@ambionframework/claude`     | The Claude Agent SDK executor                                                         |
| `@ambionframework/codex`      | The Codex SDK executor                                                                |
| `@ambionframework/workspace`  | The resource contract, a directory workspace, and a SQL resource                      |
| `@ambionframework/assistant`  | A default assistant that guides membership and writes summaries                       |
| `@ambionframework/journal`    | The append-only journal and its storage contract                                      |
| `@ambionframework/pi-journal` | Pi transcript sessions over journal storage                                           |
| `@ambionframework/cloudflare` | Rooms and seats as Durable Objects                                                    |

## Boundaries and limits

- Full history remains in storage and replay. `limits.context` bounds what
  one activation reads, and `limits.message` bounds what one message
  carries. [Envelope](envelope.md) lists every limit and its default.
- Activation deadlines and retry caps impose no total exchange budget.
  Continuing contributions keep an exchange open.
- Tools can act before a contribution commits. Applications own effect
  idempotency; conversation freshness does not make external effects
  transactional.
- Await `abort()` or `stop()` to confirm their durable room-wide work. A
  graceful stop ends running leases and keeps pending work for the next run.
  See the [cancellation contract](durability.md#cancellation).
- A process crash records no departure. Hosts reconcile durable presence
  with their connections after recovery.
- Subscriptions belong to a running host. A reconnecting client reads
  durable messages and reacquires exchange handles.
- A workspace provides no operating-system isolation between agents. One
  host owns each resource.
- A seat with harness memory holds state the record does not show.
- A room remains available between interactions. Native timers, external
  event subscriptions, and scheduler ingress are future work.
- The journal owns no domain transactions and no credentials. Browser-only
  execution and a managed service are not provided.
