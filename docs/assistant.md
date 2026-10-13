# Default assistant

**The assistant package supplies a default implementation for ordinary rooms.**
`@ambionframework/assistant` provides `defineAssistant()`. The
`startRoom({ assistant })` option supplies its room configuration. The
workbench example uses both. This document defines the behavior.

## Responsibility

**The assistant keeps the roster fit, routes each request, and summarizes
closed exchanges.** It seats a reserve specialist when the request
needs one. It unseats a specialist when the person asks or the scope no longer
needs it. It is passive when the specialists are seated at `broadcast`
or `presence` attention. It speaks during an exchange only when a
participant asks it a question, when a seated specialist at `named` attention
needs a directed request, when the application instructions require a message,
or, rarely, to stop a forbidden action.

The assistant is an ordinary agent. The kernel continues to own the roster,
activation authority, freshness checks, exchange closure, and summary
provenance. Other agents retain their existing seats and speech tools.
The package introduces no privileged role or separate execution lifecycle.

| Responsibility | Default behavior                                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seating        | Seat specialists whose expertise can materially affect the result. Unseat on request or on a clear change of scope.                                                                                                                                                                                                  |
| Routing        | Send one directed request to a seated specialist at `named` attention, with every constraint that is still in force.                                                                                                                                                                                                 |
| Answers        | Answer a participant that asks the assistant a question. A report is not a question. A question to the room is for the specialists. The summary reports what they said.                                                                                                                                              |
| Summaries      | Report what the specialists established, with corrections, conflicts, constraints, open questions, and unresolved work.                                                                                                                                                                                              |
| Silence        | Send no message about a result, a report, or an acknowledgment. Steer only to stop a forbidden action.                                                                                                                                                                                                               |
| Constraints    | Carry every explicit constraint of the person into each routing request and each summary. Examples are a scope, an output limit, or "do not edit files". A constraint outranks a role instruction and stays in force until the person withdraws it in words.                                                         |
| Revisions      | Send at most one routing request to a specialist for each human request. A later request to involve, recheck, or revise a specialist is new direction and activates it once, even when an earlier result stays in the record. A revision request goes to the responsible specialist as one concise directed request. |

Specialists own domain judgments. The assistant must not invent extra work
after the request is satisfied or require every specialist contribution to
pass through it.

## Package and room configuration

**The package supplies a reusable agent definition.** The
`defineAssistant()` factory returns an ordinary `AgentDefinition`. It supplies
a default name, identity, and maintained behavioral instructions. Applications
supply a required `executor` function and can supply additional instructions,
tools, and bundles.

**The `executor` function picks the executor package.** The function receives
`AssistantParts`: the `instructions`, the `tools`, and the `bundles`. The
`bundles` hold the respond guidance first, then the bundles of the
application. The function returns an executor of any package. A spread of the
parts is the whole adapter. The function sets the model, `thinking`, and every
other option of its package. The executor packages give the assistant the
`compose` and `describe` tools. The package of the assistant depends on
`@ambionframework/ambion` only.

The factory places participation guidance in the existing bundle guidance
field, which reaches respond activations only. Shared instructions describe
closing behavior and application precedence. Both activation purposes retain
the application's additional instructions.

The kernel owns the shared respond policy as `DEFAULT_RESPOND_POLICY` and the
summary policy as `DEFAULT_SUMMARY_POLICY`. The package keeps only the
orchestration guidance that the kernel does not enforce.

**Additional instructions can override any assistant behavioral default.**
This includes recruitment, unseating, silence at `broadcast`, direct answers,
questions to the person, and summary content or style. The factory must state that
application instructions take precedence when they conflict with its defaults.
Defaults continue to apply where application instructions give no alternative.
The behavior described below assumes no application override.

Behavioral overrides do not change kernel authority. The room still enforces
valid seating operations, activation authority, freshness, summary source
ranges, and recipients. Instructions cannot grant tools that an activation
does not receive or change the room's configuration validation.

**The room option hides assistant registration, seating, and summary wiring.**
The `assistant` property accepts an agent definition. The core accepts
that definition without depending on `@ambionframework/assistant`.

```ts
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { memoryJournals } from '@ambionframework/journal';
import { pi, piExecution } from '@ambionframework/pi';

const assistant = defineAssistant({
  instructions: 'Prefer small, reversible changes.',
  bundles: [workspace.tools()],
  executor: (parts) => pi({ ...parts, model, thinking: 'low' }),
});

const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'delivery',
  goal: 'Implement and verify the agreed milestone.',
  assistant,
  agents: [builder, reviewer],
  seats: { builder: 'named', reviewer: 'named' },
  execution: piExecution(),
});
```

With the default assistant name, the shorthand expands before composition:

```ts
const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'delivery',
  goal: 'Implement and verify the agreed milestone.',
  agents: [assistant, builder, reviewer],
  seats: {
    assistant: 'broadcast',
    builder: 'named',
    reviewer: 'named',
  },
  summaryWriter: assistant.name,
  execution: piExecution(),
});
```

The normalization rules are:

- Register the supplied definition under its own name.
- Seat that agent at `broadcast` attention and select it as the summary writer.
- Preserve explicit seating choices for all other agents.
- When `seats` is omitted, seat every defined agent at `broadcast`
  ([Roster](roster.md#configuration)).
- Treat `seats: {}` with an assistant as seating only the assistant.
- Reject duplicate assistant names and conflicting summary or assistant
  attention settings. Do not silently replace a definition or configuration.
- Permit matching explicit settings, although the shorthand makes them
  unnecessary.

Applications that need different attention or a separate summary writer use
the explicit configuration without `assistant`.

**The `seats` map decides who participates at the start.** Omitting `seats`
seats every specialist at `broadcast`, so each one participates directly. Use
an empty map when the assistant should select specialists from the reserve:

```ts
const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'triage',
  assistant,
  agents: [builder, reviewer],
  seats: {},
  execution: piExecution(),
});
```

Only the assistant starts seated in this configuration.

**The journal records the expanded ordinary composition.** The shorthand adds
no durable assistant role or new history format. Resume still requires all
recorded agent definitions, including the assistant. A host retains the
complete definitions for resume and preserves the recorded roster.

## Speak only when the message adds value

Set the tool's `to` field to activate a named specialist:

```ts
say({ to: 'builder', text: 'Implement the requested prototype change.' });
```

A name inside `text` does not route the message. The `seat` tool routes
nothing: for an agent that is already seated, it answers
`<name> is already seated` and does not activate the agent. Check the roster
before choosing the operation.

| Situation                                                       | Assistant behavior                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A relevant specialist already receives the request              | Let it work without repeating the request.                              |
| Seating creates work for a specialist during the exchange       | Let it read the existing request. Send no assignment after the seating. |
| A seated specialist needs to be named to activate               | Send one concise directed request.                                      |
| A person addresses a named specialist directly                  | Stay silent. The message already activates the specialist.              |
| A specialist result relies on a superseded fact or a constraint | Stay silent. The summary states the conflict and the fact that applies. |
| A specialist asks for information that only the person can give | Stay silent. The summary asks the person for it.                        |
| A specialist writes that it will now take a forbidden action    | Send it one short directed say that names the constraint.               |

**The guidance names the marker that a mid-activation result carries.** The
core adds the `[new]` prefix to each message that lands while the assistant
works, and every executor sends the line unchanged. The assistant
reads a user message that starts with `[new]`, then the seq of the message. A specialist result
reads `[new] #12 [specialist → assistant] text`. The ordinary guidance names this marker
and says that the same rules apply to it. Change the marker and the guidance
together.

## Observation and completion

**The assistant observes through ordinary attention and activation rules.**
It has no continuous view of specialist execution or private tool use.
It can act only on context it receives during an authorized activation.
It does not guarantee that every omission or failure will be detected before
closure. A summary activation can report an incomplete result but cannot
repair it through further investigation.

**The room determines closure from remaining work.** The assistant has no
special completion command. It stops contributing when further intervention
has no value. Prompt guidance encourages restraint; hard exchange budgets
and roster restrictions require enforcement outside the prompt.

## Goals and preferences

Human preferences currently reach only the summary activation. They describe
how that person wants to read the response. Respond activations receive the
room goal and conversation, but do not receive those private preferences.

Working preferences, such as prioritizing cost over speed, need explicit
scope and visibility during a respond activation. For this implementation, provide
shared working constraints through the room goal, conversation, or application
instructions. Do not claim that the package automatically reads private
preferences during a respond activation. Broader preference routing needs a separate
contract, including how preferences from multiple people interact.

## Validation commands

Run `pnpm check` for formatting, builds, types, lint, and deterministic tests.

The provider evaluations require credentials for `AMBION_MODEL` and for
`JUDGE_MODEL`. The model defaults to `anthropic/claude-sonnet-5` with
`ANTHROPIC_API_KEY`, and the judge's model defaults to `AMBION_MODEL`. Name
a model of another provider for the judge. `AMBION_THINKING` and `JUDGE_THINKING`
set the thinking levels, `off` by default. The suite skips without both
credentials. Run it after building:

```sh
pnpm --filter @ambionframework/assistant test:live
pnpm --filter @ambionframework-examples/workbench test:live
```

The assistant suite runs on [the simulator](simulator.md). The Workbench suite runs two example rooms
with real agents. These evaluations sample
model behavior; they do not guarantee that every model follows the defaults.
