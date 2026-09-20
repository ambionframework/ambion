# Default assistant

**The assistant package supplies a default implementation for ordinary rooms.**
`@ambionframework/assistant` provides `defineAssistant()`. The
`startRoom({ assistant })` option supplies its room configuration. The
workbench example uses both. This document defines the behavior and the evidence needed to evaluate it.
See the [acceptance review](../planning/evidence/2026-09-16-assistant-acceptance.md) for observed results and
remaining behavioral blockers.

## Responsibility

**The assistant helps the room advance the user's stated goal.** It guides
membership, provides exceptionally rare steering, and summarizes closed
exchanges. It uses the room goal, the user's request, relevant preferences,
and the discussion to decide whether an intervention helps.

The assistant is an ordinary agent. The kernel continues to own membership,
activation authority, freshness checks, exchange closure, and summary
provenance. Other agents retain their existing membership and speech tools.
The package introduces no privileged role or separate execution lifecycle.

| Responsibility | Default behavior                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Membership     | Seat specialists whose expertise can materially affect the result. Unseat conservatively.          |
| Steering       | Intervene extremely rarely, only with clear evidence of divergence or context rot in the exchange. |
| Summaries      | Answer the opening question and preserve decisions, evidence, constraints, and unresolved work.    |
| Restraint      | Stay silent when the room already has the context and participants needed to progress.             |

The assistant can answer simple questions directly. Specialists own domain
judgments. The assistant must not invent extra work after the request is
satisfied or require every specialist contribution to pass through it.

## Package and room configuration

**The package supplies a reusable agent definition.** The
`defineAssistant()` factory returns an ordinary `AgentDefinition`. It supplies
a default name, identity, and maintained behavioral instructions. Applications
choose the model and can supply additional instructions, tools, and bundles.

The factory places participation guidance in the existing bundle guidance
field, which reaches ordinary activations only. Shared instructions describe
closing behavior and application precedence. Both activation purposes retain
the application's additional instructions.

**Additional instructions can override any assistant behavioral default.**
This includes recruitment, unseating, steering frequency, direct answers,
clarification, and summary content or style. The factory must state that
application instructions take precedence when they conflict with its defaults.
Defaults continue to apply where application instructions give no alternative.
The behavior described below assumes no application override.

Behavioral overrides do not change kernel authority. The room still enforces
valid membership operations, activation authority, freshness, summary source
ranges, and recipients. Instructions cannot grant tools that an activation
does not receive or change the room's configuration validation.

**The room option hides assistant registration, seating, and summary wiring.**
The `assistant` property accepts an agent definition. The core accepts
that definition without depending on `@ambionframework/assistant`.

```ts
import { startRoom } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';

const assistant = defineAssistant({
  model,
  instructions: 'Prefer small, reversible changes.',
  bundles: [workspace.tools()],
});

const room = await startRoom({
  name: 'delivery',
  goal: 'Implement and verify the agreed milestone.',
  assistant,
  agents: [builder, reviewer],
  seats: { builder: 'named', reviewer: 'named' },
});
```

With the default assistant name, the shorthand expands before composition:

```ts
const room = await startRoom({
  name: 'delivery',
  goal: 'Implement and verify the agreed milestone.',
  agents: [assistant, builder, reviewer],
  seats: {
    assistant: 'broadcast',
    builder: 'named',
    reviewer: 'named',
  },
  summary: assistant.name,
});
```

The normalization rules are:

- Register the supplied definition under its own name.
- Seat that agent at `broadcast` attention and select it as the summary writer.
- Preserve explicit seating choices for all other agents.
- Preserve existing defaults when `seats` is omitted: all defined agents start
  at `broadcast` attention.
- Treat `seats: {}` with an assistant as seating only the assistant.
- Reject duplicate assistant names and conflicting summary or assistant
  attention settings. Do not silently replace a definition or configuration.
- Permit matching explicit settings, although the shorthand makes them
  unnecessary.

Applications that need different attention or a separate summary writer can
use the existing explicit configuration. Omitting `assistant` preserves the
current API behavior.

**Omitting `seats` starts all specialists immediately at broadcast attention.**
This preserves the existing default and permits direct specialist participation.
Use an empty map when the assistant should select specialists from the reserve:

```ts
const room = await startRoom({
  name: 'triage',
  assistant,
  agents: [builder, reviewer],
  seats: {},
});
```

Only the assistant starts seated in this configuration. The two configurations
make different choices about initial participation; the shorthand preserves
that choice for the application.

**The journal records the expanded ordinary composition.** The shorthand adds
no durable assistant role or new history format. Resume still requires all
recorded agent definitions, including the assistant. A host retains the
complete definitions for resume and preserves recorded membership.

## Speak only when the message adds value

**Repeating the user's prompt adds no value when the specialist already
receives it.** The shared record contains the request. Seating a specialist
gives it access to that record under the existing activation rules. The
assistant must not automatically follow every seating operation with a
restatement of the request.

An idle specialist with `named` attention needs a directed message to activate.
In that case, send the shortest useful request to that specialist. Reference
the existing question and add only the scope or constraint needed for its work.
Do not reproduce the full prompt merely to route it.

**Explicit user constraints survive specialist handoffs.** Scope limits,
selected items, output length or format, deadlines, and permissions such as
“do not edit files” apply to every specialist. Role instructions supply
defaults and yield to those constraints. If named activation is required,
include the relevant constraint in the one concise directed request. When a
human asks for a revision, combine the feedback and constraints in one request
and do not send an acknowledgement or a second equivalent request.

Set the tool's `to` field to activate a named specialist:

```ts
say({ to: 'builder', text: 'Implement the requested prototype change.' });
```

A name inside `text` does not route the message. Seating an agent that is
already seated does not activate it. Check the roster before choosing the
operation.

| Situation                                                       | Assistant behavior                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A relevant specialist already receives the request              | Let it work without repeating the request.                                               |
| Seating creates work for a specialist during the exchange       | Let it read the existing request; add a message only when it supplies missing direction. |
| An idle specialist needs to be named to activate                | Send one concise directed request.                                                       |
| A review depends on an artifact that does not exist yet         | Request review when the artifact becomes available.                                      |
| The record clearly shows divergence from an explicit constraint | Give one minimal correction if no participant has already corrected it.                  |
| Another participant already supplied the needed correction      | Stay silent.                                                                             |

Independent contributions can proceed concurrently. Dependent contributions
must have their required inputs. Avoid announcements, acknowledgements,
repeated assignments, and coordination messages that create further work
without advancing the request.

**A specialist's answer needs no forwarding.** Even a result addressed to
the assistant is visible in the shared record. During ordinary work, do not
repeat that result or write a preliminary summary. End the activation when
no useful work remains. The room assigns closing work separately.

**The guidance names the marker that a mid-activation result carries.** The
room delivers a message that lands while the assistant works as a user message
that starts with `[new]`. A specialist result reads
`[new] [specialist → assistant] text`. The ordinary guidance names this marker
and says to end without a tool call. Change the marker and the guidance
together.

**A trial measured the effect.** The specialist answered after the assistant
had decided to end. With the original guidance, the assistant relayed the
result in 5 of 30 runs. With the marker `[steer]`, it relayed in 18 of 30.
With the new guidance and `[new]`, it relayed in 0 of 30.

Assignment deduplication is scoped to the current exchange. A later human
request that explicitly asks for a specialist to be involved, to recheck, or to
revise is new direction even when an earlier exchange left a similar answer or
artifact. Activate the specialist once for that request; silence remains the
default when the user has not renewed the work.

## Exceptional steering

**Steering should occur extremely rarely.** Intervene only when the exchange
contains clear evidence of divergence or context rot. Divergence means that
work departs from the stated outcome or an explicit constraint. Context rot
means that work relies on superseded facts, forgets an accepted correction,
or repeats a resolved decision because relevant context was lost.

The assistant must identify the relevant statement or action and the goal,
constraint, or correction it contradicts. Speculation about future drift is
insufficient. A different approach, ordinary disagreement, silence, or work
in progress does not by itself justify steering.

Treat specialist statements as reports until they are supported by tool
evidence. Before repeating a claim that a known artifact or capability is
missing, inspect the concrete path or capability when it is available. An
empty broad search is inconclusive. If sources conflict, preserve and qualify
the contradiction instead of writing a downstream artifact or summary that
states the unsupported claim as fact.

Check whether another participant has already corrected the issue. If a
correction is still needed, make it once with the minimum useful context.
Then let the specialists continue. Do not add routine progress checks,
commentary, repeated reminders, or unsolicited improvements to their approach.
Required directed activation and necessary user clarification remain separate
reasons to speak; neither justifies routine supervision.

**The assistant observes through ordinary attention and activation rules.**
It has no continuous view of specialist execution or private tool use.
It can act only on context it receives during an authorized activation.
It does not guarantee that every omission or failure will be detected before
closure. A closing activation can report an incomplete result but cannot
repair it through further investigation.

## Membership and completion

**Membership changes serve the work.** Select specialists from the identities in
their definitions and the current request. Avoid recruiting every remotely related
specialist by default. Retain specialists across exchanges by default.
Unseat when the user requests removal or a clear scope change makes continued
participation unnecessary. Being idle alone is not a reason to remove an agent.

Unseating can interrupt active work and settle pending assignments. Do not
use it as routine cleanup after each contribution. Avoid repeated seating
and unseating. The assistant's seat is fixed as the summary writer: no
agent, including the assistant itself, can unseat it through the room's
`unseat` tool. Only the host can remove it through `room.unseat`.

**The room determines closure from remaining work.** The assistant has no
special completion command. It stops contributing when further intervention
has no value. Prompt guidance encourages restraint; hard exchange budgets
and membership restrictions require enforcement outside the prompt.

## Goals and preferences

**The room goal and the user's current request guide ordinary work.** Later
user corrections can change the requested outcome. An explicit change from
the user is new direction, not evidence of agent divergence. Ask about a
conflict with the room goal only when the intended scope remains materially
unclear.

**Clarification must resolve a consequential ambiguity.** Proceed with a
reasonable, reversible assumption when the missing detail does not materially
change the outcome or authority to act. Ask a concise question when it does.
Do not repeat a question that another participant has already asked.
Independent work can continue while an answer is pending. Do not treat
silence as authorization for work that requires the answer.

If the exchange closes with an unanswered question, record the unresolved
dependency. Distinguish waiting for the user from completing the request.
Closure does not prove that the goal was achieved.

Human preferences currently reach only the closing activation. They describe
how that person wants to read the response. Ordinary activations receive the
room goal and conversation, but do not receive those private preferences.

Working preferences, such as prioritizing cost over speed, need explicit
scope and visibility during ordinary work. For this implementation, provide
shared working constraints through the room goal, conversation, or application
instructions. Do not claim that the package automatically reads private
preferences during steering. Broader preference routing needs a separate
contract, including how preferences from multiple people interact.

## Summaries

**Closing summaries also become context for later agents.** Preserve material
corrections, decisions, quantities, dates, owners, constraints, uncertainty,
and unfinished commitments. Distinguish verified outcomes from proposals.
State when the discussion did not answer the user's question.

When available context shows specialist failure or an incomplete result,
describe the gap and its effect on the answer. Do not infer success from
silence or closure. Do not create an automatic retry cycle or repeat the same
assignment without new evidence that another attempt can help. Report a
remaining gap in the summary, including any decision needed from the user.

Source or artifact presence proves that the material was found or inspected;
it does not prove that behavior shipped, released, deployed, or became a new
scope decision. Preserve the verification limit and distinguish a static
prototype from delivered capability.

Adapt presentation to the assigned recipient's preferences without removing
facts needed for later work. Avoid a transcript recap or a second performance
of the discussion. The existing summary contract permits the writer to
decline; the source discussion then remains available in agent context.

A closing activation receives only `say`, with a fixed source range and
recipient. It cannot seat agents, use domain tools, or reopen investigation.
Necessary steering must occur during ordinary work before the exchange closes.
See [Summaries](summary.md) for the existing authority and completion rules.

## Integration and evaluation

**The workbench example is the first consumer and the acceptance target.** Its
rooms use the package factory with the lab's domain context and workspace
tools. The example exposes the assistant, the specialist definitions, and the
complete definitions. Startup uses the shorthand; resume supplies the complete
definitions. [The example page](example.md) describes each room. Exercise every
room when evaluating changes to the shared behavior.

**Deterministic checks and behavioral evaluations establish different facts.**

Use deterministic tests for shorthand equivalence, configuration conflicts,
membership, summary assignment, and resume. Use behavioral evaluations for
specialist selection, steering quality, summary fidelity, and restraint.
Evaluate redundant routing explicitly: a specialist that already receives
the user's request must not require an assistant restatement.

Include named activation, dependent review, changed user instructions,
unresolved disagreement, conservative unseating, and successful silence.
Include specialist failure and incomplete results. Check that the assistant
reports gaps accurately without inventing success or repeatedly assigning work.

Include explicit constraints that must survive seating and handoff, including
an item scoped draft with a no-file-edits instruction. Include a known artifact
that a specialist incorrectly reports as missing after an unhelpful broad
search; the assistant should qualify the report using the checked path. Include
a human revision and check that it causes one concise directed activation.

Compare clear divergence and context rot with ordinary disagreement and work
in progress. Require a minimal correction only in the evidence-backed cases,
and silence when a participant has already supplied that correction.
Test material clarification, reversible assumptions, and summaries that
distinguish waiting for the user from completion.

Evaluate explicit application overrides of assistant defaults, including
steering policy. Check that kernel authority remains unchanged.

Verify that summaries preserve constraints needed in later exchanges.
Measure coordination messages and unnecessary activations alongside task
completion. A shorter conversation alone does not prove better behavior.

The initial project adds no scheduler, workflow engine, privileged capability
system, separate goal database, or automatic preference persistence. Further
configuration should follow evidence from consumers.

## Validation commands

Run `pnpm check` for formatting, builds, types, lint, and deterministic tests.
Run `node scripts/cli-team-smoke.mjs` to check packed exports and a consumer
that starts and resumes a room with the assistant shorthand.

The provider evaluations require credentials for `AMBION_MODEL`. They default
to `anthropic/claude-sonnet-5` with `ANTHROPIC_API_KEY` and skip without that
credential. Run them after building:

```sh
pnpm --filter @ambionframework/assistant test:live
pnpm --filter @ambionframework-examples/workbench test:live
```

The assistant suite uses a real assistant with controlled specialist evidence.
It checks routing, silence, correction of obsolete constraints, incomplete
results, and application overrides. The Workbench suite runs two example rooms
with real agents. These evaluations sample
model behavior; they do not guarantee that every model follows the defaults.
