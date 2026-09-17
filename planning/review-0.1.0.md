# 0.1.0 hardening review

Reviewed on 2026-09-17 against main `deaaf94`, after PR #150, and revisited
the same day after PR #153 opened and the live tier reported on PR #151 and
PR #152. One reviewer read the runtime, the journal, the adapters, the
examples, the docs, and the open pull requests. Two deterministic probes
reproduced the two correctness findings below. No provider calls were used.
This document is an input to [next.md](next.md), which owns the delivery
plan. [release-0.1.0.md](release-0.1.0.md) owns the scope.

**Baseline.** On Node 22.22 with the engine check bypassed, `pnpm build`,
the core suite, Biome, Knip, and Prettier all pass.

| Check                     | Result                                   |
| ------------------------- | ---------------------------------------- |
| `pnpm install` on Node 22 | Refused by `@opentui/core` (see C1)      |
| `pnpm build`              | 7 packages built                         |
| Core scripted suite       | 74 files, 823 tests passed in 30 seconds |
| `pnpm check:lint`         | Passed; one Knip configuration hint      |
| `pnpm check:format`       | Passed                                   |

## The bar

**A developer learns four nouns and the journal derives the rest.** The
application concepts are definitions, room, visit, and exchange. Every other
concept is either a hosting concern or a fold over the journal. The kernel
is sophisticated when one recorded fact has one interpretation, and the
proof of that interpretation is a pure function with a contract.

**Judge each proposal by the obligation it removes.** A proposal below earns
its place when it removes a rule the developer must remember, a hidden rule
the kernel applies, or a second owner for one fact. A rename earns its place
only when two names currently mean one thing, or one name means two things.

## Summary

| Id  | Improvement                                             | Kind        | Size   |
| --- | ------------------------------------------------------- | ----------- | ------ |
| A1  | Retry a commit under its key before reporting it lost   | Correctness | Small  |
| A2  | Let unclaimed work survive a graceful stop              | Correctness | Small  |
| A3  | Bind delivery keys and identity to journal facts        | Correctness | PR 152 |
| B1  | Fold the journal incrementally                          | Design      | Large  |
| B2  | Split the room host by mechanism                        | Design      | Medium |
| B3  | One vocabulary for limits                               | Design      | Small  |
| B4  | Give the runtime a nominal identity                     | Design      | Small  |
| B5  | Two entries: application and hosting                    | Design      | Medium |
| B6  | Separate mechanism text from speaking policy in prompts | Design      | Medium |
| B7  | Typed refusals                                          | Design      | Small  |
| B8  | Activation identity on every execution event            | Design      | Small  |
| B9  | Keep the Cloudflare object on the core read model       | Design      | Small  |
| C1  | Install on the supported Node floor                     | Experience  | Small  |
| C2  | Publish the deterministic test tools                    | Experience  | Medium |
| C3  | A Node template for `ambion new`                        | Experience  | Medium |
| C4  | Retire pre-release residue from docs and comments       | Experience  | Small  |
| C5  | One word, one meaning: the naming list                  | Experience  | Medium |
| C6  | Small sharp edges in the application API                | Experience  | Small  |
| C7  | Lighten the planning and evidence files                 | Experience  | Small  |
| D1  | Classify a permanent failure and stop retrying it       | Scope       | Small  |
| D2  | Usage and cost on every activation                      | Scope       | Small  |
| D3  | A journal format promise with golden fixtures           | Scope       | Medium |
| D4  | Membership authority for independently owned agents     | Scope       | Small  |
| D5  | Bounded activation context and message size             | Scope       | Medium |
| D6  | Conformance suites for storage and transport            | Scope       | Medium |
| D7  | A public registry                                       | Scope       | Small  |
| D8  | A trust statement between owners                        | Scope       | Small  |
| D9  | Provider evidence beyond one account                    | Scope       | Small  |
| D10 | An API reference                                        | Scope       | Small  |

Section D names scope the release documents do not. Section E assesses the
open pull requests. Section F proposes the order.

## A. Correctness

### A1. Retry a commit under its key before reporting it lost

**Problem.** [`runner.ts`](../packages/ambion/src/execution/runner.ts) sends
a claim and a release up to `call.attempts` times through `calls()`. It sends
a commit once, through `call()`. When the reply to a commit is lost, the
`say` tool throws and the model reads a tool error. A model that says the
same thing again uses a new tool call id, and the journal deduplicates by
key. The freshness check then refuses the second say and lists the missed
messages, which include the model's own first message. Whether the record
holds one answer or two depends on the model reading that list. A
deterministic probe held the first commit reply past the 100 ms timeout with
a model that repeats after an error: the runner made three commits and the
record holds the worker's answer twice.

[`runner-liveness.test.ts`](../packages/ambion/test/runner-liveness.test.ts)
covers the first half of this path ("keeps an applied commit when its reply
is lost") and stops before the model reacts to the error.

**Solution.** Send a commit through `calls()` with the same key. The journal
returns the original entry for a repeated key, so a retry is safe. When every
attempt is lost, end the tool call with `terminate: true` and a result that
says the outcome is unknown. The next activation reads the record and sees
whether the message landed. Add the probe as a regression on memory and
SQLite.

**Impact.** A lost reply on a slow storage or an RPC hop no longer produces
duplicate speech. The runner applies one rule to all three room calls.

### A2. Let unclaimed work survive a graceful stop

**Problem.** `room.stop()` calls `stopWork()` in
[`room-host.ts`](../packages/ambion/src/room-host.ts), which ends every entry
in `state.due` with reason `revoked`, including wakes no activation has
claimed. [`lease.ts`](../packages/ambion/src/room/lease.ts) counts a revoked
lease at the message position as answered. After a resume, the room never
wakes the seat for that message.

A probe sent one question while the executor took no wakes, then ended the
run two ways. After `runtime.evict()`, the resumed room woke the worker and
recorded its answer. After `room.stop()`, the resumed room recorded a revoked
lease and no answer. A crash preserves a person's question and a graceful
stop discards it. Relay's shutdown path calls `room.stop()` for every room,
so a rolling restart of Relay drops unanswered questions.
[`durability.md`](../docs/durability.md) states that work can remain pending
through a shutdown, and
[`deployment.md`](../docs/deployment.md) states that stop settles every
pending activation. The two statements disagree, and the code follows the
second.

**Solution.** Let stop end only leases that are running: the executor is
going away, so its authority ends. Write nothing for an activation that
never claimed. Resume derives `due` from the journal, so the wake is pending
again with its attempt count intact. Keep the exchange open across the stop;
the resumed run closes it when the work completes. Apply the same rule to an
owed summary draft. Update both documents to one statement and add the probe
as a regression with the "preserves an open exchange" case in
[`stop-work.test.ts`](../packages/ambion/test/stop-work.test.ts).

**Impact.** A deploy restart of a persistent host loses no accepted question.
The release claim "restart without losing accepted contributions or pending
work" becomes true for the graceful path.

### A3. Bind delivery keys and identity to journal facts

**Problem.** [next.md §2](next.md) records three confirmed defects: a reused
delivery key acknowledges another person's message, the journal exposes its
mutable cache, and the Cloudflare object writes a person's identity before
admission.

**Solution.** PR #152 addresses all three with no new public room API and
one new journal method, `entriesFrom(start)`. Section D reviews it. Merge it
before the exchange outcome work and before B1.

**Impact.** A retry after a lost acknowledgement can only return its own
receipt. The journal owns its cache. The Cloudflare adapter keeps no second
identity store.

## B. Architecture

### B1. Fold the journal incrementally

**Problem.** [`room-host.ts`](../packages/ambion/src/room-host.ts) reads
`state()` on every heard entry, every dispatch, every read, and every
reconcile pass. `state()` calls `evolve()` for each new entry, and
[`transition.ts`](../packages/ambion/src/room/transition.ts) implements
`evolve` as `baseOf` (copy every base array), `applyEvent`, and `project`.
[`fold.ts`](../packages/ambion/src/room/fold.ts) implements `project` as a
full recomputation: people from every message, the roster from every
message, pending wakes from every message against every lease, owed
summaries from every close against every lease. One new entry costs the
whole history. [next.md §4](next.md) measured 590 ms for the initial fold and
48 ms per new question at 1,000 closed exchanges, and 10 seconds and 412 ms
at 4,000. PR #152 adds a clone per heard entry and per read, which raises
the constant.

**Solution.** Make `RoomState` an evolving projection. Keep indexes that one
entry updates in constant or per-seat time: people by name, roster, the open
exchange, pending activations by seat, owed drafts by close, and the
delivery of the last message. Let `applyEvent` update those indexes and let
`project` become a read of them. Keep `foldRoom(entries)` as the reference
implementation and add one property test that folds a random walk both ways
and compares the results under cancellation, reseating, late summaries,
takeover, and restart. [`property.test.ts`](../packages/ambion/test/property.test.ts)
and [`chaos.test.ts`](../packages/ambion/test/chaos.test.ts) already generate
the walks. Publish the measured envelope from next.md §4 again after the
change.

**Impact.** The cost of a current operation follows the current work. A room
with a year of history answers a question at the speed of a room with one.
The thesis that pure rules interpret the journal gains a proof that the
incremental rules agree with the full replay.

### B2. Split the room host by mechanism

**Problem.** `room-host.ts` holds 1,468 lines and seven mechanisms:
lifecycle phases with compose and recover, visits and departures, delivery
state and dispatch to ports, the publication tail, the reconcile loop and
alarm, stop and abort and evict, and exchange waiters. Biome bounds the
complexity of one function at 10. Nothing bounds one file, so the room host
grew through small methods. A reader who wants the delivery rule reads past
the visit rule to find it. [next.md §8](next.md) proposes path moves and
says to move responsibilities first.

**Solution.** Cut the file along its mechanisms before any path moves. Give
each part the narrow view of the room it needs, the way
[`answers.ts`](../packages/ambion/src/answers.ts) takes an `Answering`
interface today.

| Part               | Owns                                                     |
| ------------------ | -------------------------------------------------------- |
| `host/room.ts`     | Phases, compose, recover, supersede, `submit`, `hear`    |
| `host/people.ts`   | Arrivals, departures, the visit handle                   |
| `host/dispatch.ts` | Ports, delivery state, send, steer, cut, delivery errors |
| `host/waits.ts`    | Exchange handles, close and summary waiters              |
| `host/control.ts`  | Reconcile loop, alarm, stop, abort, evict                |

Add a Biome or Knip rule for a file line budget in `packages/ambion/src`,
so the split holds.

**Impact.** Each mechanism reads in one place and tests in one place. The
next reviewer of the delivery rule reads 200 lines.

### B3. One vocabulary for limits

**Problem.** The runtime exposes three limit groups whose names do not say
what they bound, and the source holds two constants beside them.

| Name                     | Bounds                                   | Default  | Read by         |
| ------------------------ | ---------------------------------------- | -------- | --------------- |
| `wake.resend`            | Time before an unanswered wake is resent | 5 s      | `reconcile.ts`  |
| `wake.expiry`            | Lease time between renewals              | 60 s     | `transition.ts` |
| `wake.deadline`          | Activation time from its claim           | 600 s    | `transition.ts` |
| `retry.attempts`         | Failed activations before abandonment    | 3        | `reconcile.ts`  |
| `retry.backoff(attempt)` | Wait before the next attempt             | 30 s × n | `lease.ts`      |
| `call.attempts`          | Lost claim and release calls             | 2        | `runner.ts`     |
| `call.timeout`           | Time per executor call to the room       | 10 s     | `runner.ts`     |
| `AUDIT_ATTEMPTS`         | Transcript writes per activation         | 2        | `activation.ts` |
| `PASSES`                 | Reconcile passes before the room yields  | 8        | `room-host.ts`  |

`wake.expiry` and `wake.deadline` bound a lease and an activation. `retry`
bounds activations and `call` bounds transport calls. A developer who tunes
one group must read three files to learn which one applies.

**Solution.** Name each group by what it bounds and keep the defaults.

```ts
limits: {
  delivery: { resend: 5_000 },
  lease: { ttl: 60_000, deadline: 600_000 },
  activation: { attempts: 3, backoff: (n) => n * 30_000 },
  call: { attempts: 2, timeout: 10_000 },
}
```

Document the two constants in the same table. Apply the rename before the
API freeze in section E.

**Impact.** One table answers every question about time and retry. The
Cloudflare `configure()` options and the runtime options read the same way.

### B4. Give the runtime a nominal identity

**Problem.** `Runtime` in [`host/runtime.ts`](../packages/ambion/src/host/runtime.ts)
is a structural interface. Its identity lives in a private `WeakMap`. A
spread copy satisfies the type and fails at the first call with "Runtime
must come from createRuntime." The interface also exposes `storage`,
`journals`, `transcripts`, `stream`, `model`, `transport`, and `evict`,
which an application never reads. `defaultRuntime` is created when the
module loads, so importing the library opens memory storage and a Pi
session opener as a side effect.

**Solution.** Brand the type with a unique symbol so a structural copy fails
at compile time. Narrow the application view to `clock` and `storage`. Move
`evict`, `transcripts`, `stream`, `model`, and `transport` to the hosting
entry (B5). Create `defaultRuntime` on first use.

**Impact.** The compiler reports the mistake the WeakMap reports at runtime.
Importing the library does nothing.

### B5. Two entries: application and hosting

**Problem.** `@ambionframework/ambion/transport` exports the runner, the
execution services, the audit session id, the live-room lookup, and the wire
types. Its name says less than it holds. The main entry exports
`Room.reconcile()`, which only a host with its own alarms calls, and
`runtime.evict()`, which only a host calls. PR #73 and PR #63 proposed four
entries. [next.md §7](next.md) proposes one advanced entry named
`/hosting`.

**Solution.** Ship two entries. The main entry holds definitions, rooms,
visits, exchanges, reads, and the value types. The `/hosting` entry holds
everything a host or an adapter composes.

| Moves to `/hosting`                                            | From         |
| -------------------------------------------------------------- | ------------ |
| `AgentRunner`, `inProcessTransport`, `createExecutionServices` | `/transport` |
| `seatSessionId`, `runningRoom`, the protocol types             | `/transport` |
| `Transport`, `SeatContext` (renamed per C5), `ModelResolver`   | main         |
| `Room.reconcile()` as `reconcileRoom(runtime, name)`           | main         |
| `runtime.evict(name)` as `evictRoom(runtime, name)`            | main         |

Remove `/transport` in the same change. There are no external consumers
before 0.1.0, so no alias is needed. Extend
[`package.test.ts`](../packages/ambion/test/package.test.ts) to assert the
full sorted export list of each entry, so an accidental export fails CI.
PR #73 proposed that assertion.

**Impact.** The main entry lists the four concepts and their reads. A
developer who opens the hosting entry knows they are composing a host.

### B6. Separate mechanism text from speaking policy in prompts

**Problem.** [`render.ts`](../packages/ambion/src/execution/render.ts) holds
about 11,600 characters of prompt text in 72 template strings.
[`summary.ts`](../packages/ambion/src/execution/summary.ts) holds the closing
duties. [`assistant/src/index.ts`](../packages/assistant/src/index.ts) holds
about 7,700 characters more. Part of that text describes the mechanism: the
record format, the `[new]` marker, the fold line for a summary, what a
refused say returns. Part of it is speaking policy: silence as the default,
"attention costs money", never greet an arrival, when to seat a colleague.
The kernel applies the policy to every agent from every owner, and an agent
definition cannot replace it. [`assistant-acceptance.md`](../docs/assistant-acceptance.md)
shows the policy text moving through live-test iterations, and each move is
a kernel change.

**Solution.** Keep the mechanism text in the kernel and keep it short. Move
the speaking policy to one exported constant, `DEFAULT_GUIDANCE`, that
`defineAgent` applies unless the definition supplies `guidance` of its own or
sets it to `false`. Let the assistant package supply its guidance the same
way it does today. Add one snapshot test of the rendered system prompt and
turn context for an ordinary and a closing activation, so every change to
the text is visible in review.

**Impact.** The agent owns its behavior, which is the thesis. A change to
the default policy is one file and one snapshot. The kernel's own text
describes only what the kernel does.

### B7. Typed refusals

**Problem.** The core throws 75 plain `Error` values with English messages.
A host that must map a refusal to an HTTP status reads the message. Relay
attaches a `status` field to its own errors and lets kernel errors fall to 500. The Cloudflare template defines a `RequestError` for the same purpose.
A stopped room, an ended visit, an absent author, an unknown agent, and a
duplicate name are five different conditions with one type.

**Solution.** Add one error class with a closed set of codes and keep the
messages.

```ts
export class AmbionError extends Error {
  readonly code: AmbionErrorCode;
}
type AmbionErrorCode =
  | 'room_stopped'
  | 'room_running'
  | 'no_composition'
  | 'missing_definition'
  | 'visit_ended'
  | 'not_present'
  | 'unknown_participant'
  | 'duplicate_name'
  | 'invalid_name'
  | 'invalid_tool'
  | 'refused'
  | 'stale'
  | 'superseded';
```

Throw it from every site in `room.ts`, `room-host.ts`, and `define.ts`.
Carry the `Refusal` reason on `refused`. Let Relay and the template map
codes to statuses.

**Impact.** A host handles a refusal without parsing prose. The messages can
improve without breaking a host.

### B8. Activation identity on every execution event

**Problem.** `RoomNotification` in [`types.ts`](../packages/ambion/src/types.ts)
carries an `activation` id on `delivery_error`, `audit_error`, and
`abandoned`. It carries none on `activation_start`, `activation_end`,
`conflict`, `tool_execution_start`, `tool_execution_end`, and `error`. A
host cannot pair a start with its end. The Cloudflare seat object works
around this in `seatLine` by substituting the seat's current activation.
The same union mixes durable room facts (`message`, `exchange_opened`,
`exchange_closed`) with local diagnostics that carry `Error` objects.

**Solution.** Add `activation: string` to every event an activation raises.
Split the union into `RoomEvent` for durable facts and `ExecutionEvent` for
diagnostics, and keep one `subscribe` over their union. Drop the seat-object
substitution.

**Impact.** A host correlates every event of one activation by one id. A
reader of the type knows which events replay from the journal and which
belong to this run.

### B9. Keep the Cloudflare object on the core read model

**Problem.** PR #148 replaced `messages()` and `participants()` on `Room`
with one `read()`. [`room-object.ts`](../packages/cloudflare/src/room-object.ts)
still exposes `messages()`, `participants()`, and a `status()` with an
`exchangeState` of `idle`, `working`, or `completed` that the core does not
define. `StartOptions` takes agent names while the core takes definitions.
The CLI template calls the old methods. The adapter is a second API for one
room.

**Solution.** Expose the core surface plus `start` and `ensureStart`: `read`,
`visit`, `send`, `leave`, `seat`, `unseat`, `abort`, `stop`, `exchange`,
`waitForClose`, `waitForSummary`. Remove `messages`, `participants`,
`status`, and `RoomStatus`. Update the template to `read()`.

**Impact.** One read model across hosts. A change to `RoomSnapshot` reaches
the adapter with no translation.

## C. Developer experience

### C1. Install on the supported Node floor

**Problem.** The root manifest and every package declare Node `>=22.19`. The
CLI depends on `@opentui/core@0.5.11`, which declares Node `>=26.4`. On
Node 22.22, `pnpm install --frozen-lockfile` fails with
`ERR_PNPM_UNSUPPORTED_ENGINE` before it installs anything, because `.npmrc`
sets `engine-strict=true`. CI installs on Node 26 and then switches to 22 or
24 for the test job, which hides the problem. A contributor or an agent on an
LTS runtime cannot run `pnpm check`. Dependabot runs on an older Node and
posted "Dependabot does not support your Node version" on each of PR #112,
#113, and #114, so it cannot rebase any npm dependency bump.

**Solution.** Load OpenTUI lazily from `ambion dev` and declare it in
`optionalDependencies`, with a clear message on an older Node. Or move the
terminal client to its own package that only the CLI depends on at
`>=26.4`. Make the root `engines` field true for the whole workspace and
add a CI step that installs on Node 22.

**Impact.** `pnpm install` works on every Node the library supports. The
CI matrix tests what a contributor runs. Dependency bumps rebase again.

### C2. Publish the deterministic test tools

**Problem.** Every scripted test in this repository runs on
[`scripted.ts`](../packages/ambion/test/support/scripted.ts) and
[`clock.ts`](../packages/ambion/test/support/clock.ts). Neither is published.
An application developer who wants a deterministic room in their own tests
must rebuild a `StreamFn` from Pi internals. `waitForRoom` in
[`room.ts`](../packages/ambion/test/support/room.ts) reaches into the private
fold, so even the repository's own wait has no public form. The runtime's
scripted path resolves models through a cast in `stubModel`
([next.md §9](next.md)).

**Solution.** Publish `@ambionframework/ambion/testing` with `scripted`,
`speak`, `quiet`, `callTool`, `byAgent`, `fakeClock`, and `settled(room)`.
Build `settled` on the public read: every agent participant `idle` and no
open exchange. Replace the `stubModel` cast with a valid scripted model.
Move the repository's tests onto the published entry.

**Impact.** A developer tests a room the way the kernel tests itself, with
no key and no network. The repository stops depending on private access
for its own waits.

### C3. A Node template for `ambion new`

**Problem.** The README leads with an embedded Node room and names the
persistent Node service as a supported model. `ambion new` creates only a
Cloudflare Worker with Wrangler, and `ambion dev` needs Node 26.4 for the
terminal client. The first command a developer runs takes them to a
deployment model the README introduces last.

**Solution.** Add `ambion new <dir> --template node` that creates the
persistent Node shape from Relay in three files: definitions, a SQLite
runtime with `startRoom` or `resumeRoom`, and a small HTTP or readline
front. Keep the Cloudflare template under `--template cloudflare`. Default to
`node`.

**Impact.** The generated project matches the README's story and runs on
Node 22.

### C4. Retire pre-release residue from docs and comments

**Problem.** Eight source comments cite numbered rules of `docs/agent.md`
("rule 5", "rule 7", "rules 1, 4 and 6"), and that document has no numbered
rules. `docs/agent.md`, `docs/exchange.md`, and `docs/roster.md` carry four
migration notes for renames that happened before any release. The core manifest
describes "a minimalist framework for ambient-aware, always-on agents" with
`cloudflare` and `durable-objects` as keywords. `demos/README.md` says the
current code uses `participants()`. Source comments use metaphor and
contrastive framing that [CLAUDE.md](../CLAUDE.md) forbids in documentation.
`docs/README.md` names `agent.md` as the entry point, and next.md wants a
room overview there.

**Solution.** Before the release tag:

- Replace each numbered-rule citation with a link to the section that holds
  the rule, or number the rules in `agent.md` again.
- Delete every pre-0.1 migration note.
- Rewrite the package descriptions and keywords to the kernel positioning.
- Rewrite file header comments in the same controlled language as the docs.
- Add `docs/room.md` as the overview and link the contracts from it.
- State two limits that the docs do not yet state: an activation's passes
  share no model context, and a second person's question inside an open
  exchange belongs to the first person's exchange.

**Impact.** A reader meets one voice and no history of names they never
used.

### C5. One word, one meaning: the naming list

**Problem.** "Seat" names five things: an agent's membership, the `seats`
map, the `seat()` operation, the executor's dependencies (`SeatContext`),
and the wire (`SeatPort`, `SeatRoom`). "Exchange" names five types:
`ExchangeRef`, `ExchangeView`, `ExchangeHandle`, `ExchangeSnapshot`,
`ClosedExchange`. The stream override is `streamFn` on a room and `stream`
on a runtime. `Visit.since` is a departure position with a cursor's name.
The docs call `agents` the catalog and the code never does.

**Solution.** Apply the renames in one change before the API freeze, with
[next.md §7](next.md) as the base.

| Current                     | Proposed                     | Reason                             |
| --------------------------- | ---------------------------- | ---------------------------------- |
| `SeatContext`               | `AgentExecutionContext`      | Seat means membership only         |
| `SeatPort` / `SeatRoom`     | `AgentPort` / `RoomProtocol` | Same                               |
| `streamFn` (room option)    | `stream`                     | One name at both scopes            |
| `Visit.since`               | `Visit.lastDeparture`        | It records a departure             |
| `ContextParticipant.unseen` | `messagesSinceDeparture`     | Reading is not recorded            |
| `ExchangeSnapshot`          | `ExchangeRead`               | A read result, like `RoomSnapshot` |
| "catalog" (docs)            | "definitions"                | The code has no catalog            |

Add a glossary to `docs/room.md` with one line per term.

**Impact.** Each term has one meaning in code, docs, and prompts.

### C6. Small sharp edges in the application API

**Problem.** Five behaviors surprise a first reader.

- `startRoom` validates participant names and never validates the room
  name.
- `summary` may name an agent that no seat holds, and every exchange then
  closes with no summary and no warning.
- `visit.send()` returns a handle whose `owner` can be another person, when
  the sender speaks into an open exchange.
- `room.seat()` rejects a repeated request while the agent tool returns
  `unchanged` ([next.md §6](next.md)).
- The `say` key is the provider's tool call id and a human delivery key is
  application text, in one journal key space.

**Solution.** Validate the room name with the participant rule. Refuse a
`summary` name that the initial seats do not hold, or document the silence
in the option's comment. Add `opened: boolean` to `ExchangeHandle`. Make the
host operation idempotent. Prefix the two key kinds in the room before they
reach the journal.

**Impact.** Fewer rules to remember, and the ones that remain are visible
in the types.

### C7. Lighten the planning and evidence files

**Problem.** `planning/next.md` is 497 lines and mixes confirmed defects,
design proposals, evidence requirements, and history. `demos/` holds
4.4 MB of generated HTML in the source tree. `docs/assistant-acceptance.md`
is a dated review under `docs/`. `LemmaScript-files.txt` sits at the root.
The repository has no changelog. PR #40 proposed one in 2026-09-03 and only
its directory move landed.

**Solution.** Reduce `next.md` to the ordered checklist in section F with
one link per item to its design note. Move dated evidence to
`planning/evidence/` and link it from the release document. Move the
LemmaScript list under `scripts/` if the verifier permits a path. Add
`CHANGELOG.md` with an `Unreleased` section written for a builder, and
require an entry from every pull request that changes a public entry.

**Impact.** A contributor reads the plan in one screen and finds evidence
by date. The 0.1.0 release notes exist before the tag.

## D. Scope the release does not yet name

**A solid 0.1.0 states its envelope, its trust model, and its cost.** The
[scope](release-0.1.0.md) and [next.md](next.md) cover collaboration
semantics, persistence, and deployment. Ten obligations of a kernel that
runs unattended, on paid models, for independently owned agents, appear in
neither document. Each item below says whether it belongs in 0.1.0.

### D1. Classify a permanent failure and stop retrying it

**Problem.** [`activation.ts`](../packages/ambion/src/execution/activation.ts)
treats every provider error alike: `failureOf` reads `stopReason: 'error'`
and the lease ends as `failed`. [`reconcile.ts`](../packages/ambion/src/room/reconcile.ts)
then retries with the activation backoff up to the attempt cap. On
2026-09-17 the live tier on PR #151 and PR #152 recorded the pattern for a
400 "credit balance is too low" reply: three activations, 90 seconds of
backoff, one `abandoned` event, and an exchange closed as silent. A wrong
key, a revoked key, and a context-length overflow take the same path. The
retry budget exists for transient failures and spends itself on permanent
ones.

**Solution.** Classify the failure at the executor boundary, where Pi
exposes the provider error. Carry `cause: 'permanent' | 'transient'` on the
`failed` lease end and on the `error` and `abandoned` events. Let the
reconcile rule abandon a permanent failure at once, with no backoff. Keep
the attempt cap for transient failures. The lease schema in
[`validate.ts`](../packages/ambion/src/journal/validate.ts) accepts extra
fields, so older journals stay readable.

**Impact.** A configuration mistake surfaces in seconds. The exchange
outcome work in [next.md §3](next.md) gains the fact it needs to say why
work stopped.

**0.1.0:** in.

### D2. Usage and cost on every activation

**Problem.** The kernel's prompt tells every agent that attention costs
money, and [`exchange.md`](../docs/exchange.md) says a host measures what an
exchange cost. Nothing records tokens or cost. Pi's `AssistantMessage`
carries `usage` with input, output, and cache tokens and a cost, and the
runner persists those messages to the audit transcript. The Pi journal holds
`SessionStats` machinery for usage records that the runner never writes.

**Solution.** Sum `usage` over an activation's messages when it releases.
Put the sum on `activation_end` and on the `released` lease entry as an
optional field. Let `ExchangeView` for a closed exchange sum the usage of
the leases in its range, so `readExchange` reports cost after a restart.

**Impact.** Cost per activation and per exchange is a read, on a live room
and on a stored one. An evaluation harness reads it from the kernel.

**0.1.0:** in.

### D3. A journal format promise with golden fixtures

**Problem.** 0.1.0 ships SQLite persistence, so a journal written by 0.1.0
must be readable by 0.1.x. The only version marker is `composition.version`.
The `run` entry holds a timestamp. The `cancel` kind arrived this month, and
[`durability.md`](../docs/durability.md) says an older runtime cannot resume
a journal that holds one. No test replays a journal that an earlier build
wrote.

**Solution.** Declare journal format 1 as the set of kinds and bodies in
`validate.ts`, and write `format: 1` on the run entry. Store golden
journals under `packages/ambion/test/fixtures/journals/` as JSON lines
dumped from memory storage for each chaos scenario, with the expected fold
beside each. Replay them in CI. State the promise in `durability.md`: a
0.1.x runtime reads every 0.1.0 journal, a new kind is additive, and a body
change raises the format.

**Impact.** A persistent service upgrades in place. The durability tier
proves compatibility on every push.

**0.1.0:** in.

### D4. Membership authority for independently owned agents

**Problem.** The thesis is independently owned agents. The kernel gives
every ordinary activation `unseat` over every agent, including the summary
writer. After that removal every exchange closes with no summary and a
`failed` outcome. The assistant package instructs its model to keep itself
seated, which puts a room rule into a prompt.

**Solution.** Add one attribute to a seat in the composition:
`seats: { editor: { attention: 'broadcast', fixed: true } }`. The summary
writer is fixed by default. An agent's `unseat` of a fixed seat is refused
with a reason in `transition.ts`; the host can always seat and unseat. No
roles and no permission matrix.

**Impact.** The room's owner states which participation is policy. The
prompt line goes away.

**0.1.0:** in.

### D5. Bounded activation context and message size

**Problem.** [`view.ts`](../packages/ambion/src/room/view.ts) hands every
ordinary activation the whole record. Only a configured summary writer
compacts closed human exchanges. A room with no writer, or one long
exchange, grows the prompt until the provider refuses it, which D1 then
classifies as permanent. The docs state the limit and offer no lever. The
kernel also accepts a message of any size; Relay caps requests at 16 KiB
and the kernel does not.

**Solution.** Add `limits.context.messages` to the room. Render the open
exchange whole, then earlier exchanges newest first until the budget, with
one line that names how many earlier messages the view omits. Keep
summaries in place of what they cover. Add `limits.message.bytes` with a
typed refusal at the room boundary. Default both to the current behavior
and document the failure mode when the open exchange alone exceeds the
budget.

**Impact.** A room has a stated maximum prompt size and a stated maximum
message. The failure mode is a documented refusal.

**0.1.0:** in, with defaults that preserve current behavior.

### D6. Conformance suites for storage and transport

**Problem.** The scope calls separate room and agent hosts an extension
contract validated by the Cloudflare reference. The storage contract has
five conformance cases in
[`storage.test.ts`](../packages/journal/test/storage.test.ts) and the
transport contract has cases only in the workerd suite. Neither is
published. A Postgres or Turso storage and a queue-based transport have no
way to prove conformance.

**Solution.** Publish `storageConformance(open)` from
`@ambionframework/journal/testing`, built from the five cases plus lost
acknowledgement and concurrent append. Publish `transportConformance()`
from the hosting entry's testing tools, built from the runner liveness
cases: wake, steer, and cut ordering, a late reply, and a cut during a
claim. Run both suites on the shipped adapters.

**Impact.** "Extension contract" becomes a checkable claim. A third-party
adapter ships with evidence.

**0.1.0:** in.

### D7. A public registry

**Problem.** Every install path requires a GitHub personal access token:
the README, the package READMEs, the CLI, and the generated `.npmrc`. The
scope defers the registry decision. A public 0.1.0 behind a token is a
private beta.

**Solution.** Publish the seven packages to npmjs under the
`@ambionframework` scope at 0.1.0. The release workflow already attests
build provenance. Keep GitHub Packages as a mirror or drop it. Remove the
token instructions.

**Impact.** `npm install @ambionframework/ambion` works.

**0.1.0:** in; this is a decision, and the work is one workflow change.

### D8. A trust statement between owners

**Problem.** Agents from different owners share a room. The kernel stamps
provenance, refuses a stale commit, and derives authority from the journal,
and no document states the trust model. An owner who seats a foreign agent
cannot read what that agent cannot do (speak under another name, change a
summary's recipient, revive cancelled work), what it can do to others
(unseat, address, steer), and what the kernel does not defend (prompt
injection through messages, tool effects, secrets in transcripts).

**Solution.** Add `docs/trust.md` with one table of guarantees and one of
non-guarantees. Link each guarantee to the test or the verified rule that
proves it. Fold D4 into it.

**Impact.** The decision to seat a foreign agent has a page.

**0.1.0:** in; documentation only.

### D9. Provider evidence beyond one account

**Problem.** The live tier runs one provider, one model, and one API key.
On 2026-09-17 every live run on PR #151 and PR #152 failed because that
account's credit balance was too low. Release evidence depends on one
account, and the release claim that provider selection follows the
installed Pi integration has evidence for one provider.

**Solution.** Run the live tier on two providers through Pi's registry,
with a separate job per provider. Fail a job on a credit or authentication
error with a message that names the account. Document the provider matrix
as tested, expected, and untested.

**Impact.** One account outage does not block a release. The provider
claim has evidence.

**0.1.0:** in; CI only.

### D10. An API reference

**Problem.** The docs point at source files for shapes ("see the public
types in `types.ts`"). A developer who wants the signature of `Room.read`
opens the repository.

**Solution.** Generate a reference for each published entry from the
emitted declarations into `docs/api/`, and link it from `docs/README.md`.
Fail CI when the reference is stale.

**Impact.** A developer reads the API without opening source.

**0.1.0:** in.

## E. In-flight pull requests

**The live tier is red on both open implementation PRs for one reason
outside them.** The "Live tests on anthropic/claude-sonnet-5" job failed on
PR #152 at 19:12 and on PR #151 at 18:57. Every failed assertion in both
logs traces to one provider reply: 400 `invalid_request_error`, "Your credit
balance is too low to access the Anthropic API." Each live room recorded
three activations, an `abandoned` event, and a silent close (see D1). The
scripted suites, lint, types, the CLI smoke, and the Dafny proofs pass on
both heads. Restore the account before any live evidence in section F
counts.

**Merge PR #152 first.** "Bind delivery receipts and identity to journal
facts" (+812/−85, 17 files) tightens the delivery contract, keeps the journal
cache private, and removes the Cloudflare identity store. Every scripted
check passes; the live failure above is the account's. Two notes for review
before merge.
A same-key retry from a later attempt is refused because the match requires
the same activation id; document that in `durability.md`. The extra clone
per heard entry raises the cost that B1 removes, so schedule B1 after it.
It conflicts with PR #151 on six files.

**Hold PR #151 out of 0.1.0.** "Add exchange-scoped Tasks and Relay
background work" (+6,126/−115, 80 files) adds a fifth application concept, a
working-room composition scope, a seventh journal entry kind with eight
subtypes, two room tools for every ordinary activation, a `TaskSeatRoom`
protocol that custom transports must implement, required fields on
`Runtime` and `RoomSnapshot`, and a parent-child room registry. Its
`TaskRecord` with status, owner, subscriptions, and event history is the
task database the [scope](release-0.1.0.md) excludes. The review found four
defects that the release bar cannot carry: unbounded `taskChanges` scanned
on every reconcile pass, `lastSeq` advanced by a non-message entry so a
close can name a position with no message, an unresolved task operation
that retries with no cap and holds the exchange open, and a `stop()` that
cancels every open task. Its own `docs/README.md` says tasks are not
implemented while `next.md` says they are. Delegation to a working room is
the right 0.2 feature. Land the design contract in `planning/` and rebuild
it on the incremental fold (B1) with a bounded change set per journal.

**Close the stale pull requests.** Nine open pull requests date from
2026-09-01 to 2026-09-11, and every one conflicts with main. Main delivered
the aim of each one by another route. Three carry one idea worth taking
before closure. Section F assumes these closures.

| PR  | Title                                                    | Recommendation                                                                |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| #73 | Split the package into four entry points                 | Close; take the export-list assertion into B5                                 |
| #67 | Close an exchange with a message                         | Close; PR #108, #123, and #148 delivered the aims                             |
| #63 | Split application surface from host and protocol exports | Close; B5 supersedes it                                                       |
| #60 | Fix queued seat wakes and refused starts                 | Close; PR #61 delivered the same mechanism                                    |
| #58 | LemmaScript and Dafny verification                       | Close; PR #59 delivered it; check findings F5 and F10 against `durability.md` |
| #48 | Refactor session into runtime, log, fold, reconcile      | Close; sliced into PRs #49 to #71                                             |
| #44 | Move quiescence out of the room                          | Close; the exchange is a fold now                                             |
| #40 | Move planning docs under `planning/`                     | Close; PR #42 moved the files; take the changelog into C7                     |
| #28 | Shorten the idea to its three claims                     | Close; the section no longer exists                                           |

**Bump the Pi pair together.** PR #113 and PR #114 each move one half of
`@earendil-works/pi-agent-core` and `pi-ai` from 0.84.3 to 0.85.1, so each
lockfile resolves two copies of `pi-ai`, and their `Context`, `StreamFn`,
and `AgentTool` types stop being assignable. That explains the red type
checks on both. The release notes name no change to `Agent`, `StreamFn`,
`AgentTool`, or `Session`. Open one pull request that bumps both packages in
`ambion`, `cloudflare`, `pi-journal`, and `workspace`, run `pnpm check`, run
the live tier once because 0.85.0 changes what an Anthropic transport
writes into replayed context, and confirm the workerd bundle size with the
new `chord` dependency. PR #112 (TypeBox 1.3.30) and PR #111 are clean and
green; merge them, then check whether one TypeBox version remains
([next.md §9](next.md)). PR #5, #6, and #7 are green. PR #4 has a stale run
from 2026-08-25 and needs a rebase before its checks mean anything.

## F. Proposed order

**Fix, then freeze, then simplify, then prove.** The order keeps every
public rename and every journal field in one window, and every behavior
fix before it.

| Step | Work                                               | Depends on | Evidence                                                                                         |
| ---- | -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| 1    | Merge PR #152; close stale PRs; bump the Pi pair   |            | CI green on main                                                                                 |
| 2    | A1, A2, D1                                         | 1          | Probes as regressions on memory and SQLite; a 400 abandons in one attempt                        |
| 3    | C1, D9                                             |            | `pnpm install` and `pnpm check` on Node 22; two live jobs                                        |
| 4    | B3, B4, B5, B7, B8, C5, C6, D4, D5                 | 2          | Generated declarations list two entries; a fixed seat refuses an agent's unseat                  |
| 5    | D2, D3: usage and format on the journal            | 4          | Golden journals replay; `activation_end` carries usage                                           |
| 6    | API and journal freeze: additive changes only      | 5          | A note in `release-0.1.0.md`                                                                     |
| 7    | B1                                                 | 1          | Equivalence property test; envelope table                                                        |
| 8    | B2, B9                                             | 4          | File budget rule; template on `read()`                                                           |
| 9    | B6, C2, C3, D6                                     | 4          | Prompt snapshots; testing entry and conformance suites in a packed consumer; Node template smoke |
| 10   | next.md §3 exchange outcomes                       | 7          | Silence, exhaustion, cancellation, and permanent failure reads                                   |
| 11   | C4, C7, D7, D8, D10, release evidence (next.md §9) | 6          | Packed consumers from npmjs; Node 22 and 24; Cloudflare; `CHANGELOG.md`; `docs/trust.md`         |

**The freeze at step 6 is the release decision.** Thirty-nine pull requests
merged between 2026-09-15 and 2026-09-17, and many renamed a public term.
The docs carry the residue of those renames. After step 5, every change to
the main entry and to the journal bodies is additive until the tag.

## G. Deferred past 0.1.0

- Exchange-scoped tasks and working rooms (PR #151), rebuilt on B1.
- A bounded projection with checkpoints; B1 keeps full replay.
- Tool execution provenance ([next.md §5](next.md)); the shape is open.
- Automatic admission expiry for unclaimed work.
- A durable subscription service across processes.
- Native timers, external event subscriptions, and scheduler ingress.
