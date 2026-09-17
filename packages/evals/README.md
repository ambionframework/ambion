# `@ambionframework/evals`

An eval configures a room simulation. A human simulator agent represents one
or more declared people. The runner delivers their messages through public room
APIs, waits for settlement, seals the evidence, and runs checks and a separate
judge. The assistant is the first consumer; the package has no assistant dependency.

```ts
import assert from 'node:assert/strict';
import { createRuntime, defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';
import {
  agentJudge,
  createHumanSimulator,
  createRoomJudge,
  defineRoomEval,
  runEvals,
} from '@ambionframework/evals';

const inventory = defineRoomEval({
  id: 'inventory/capacity',
  version: 1,
  input: { sku: 'A' },
  humans: [defineHuman({ name: 'priya', identity: 'Needs current stock capacity.' })],
  simulator: createHumanSimulator({
    model: 'anthropic/claude-sonnet-5',
    instructions:
      'Represent Priya. Ask once for available SKU A stock. ' +
      'Read the room response, then finish. Do not request dispatch.',
  }),
  limits: { maxActions: 2, settleTimeoutMs: 60_000 },
  async setup({ model }) {
    if (!model) throw new Error('A subject model is required.');
    const room = await startRoom({
      name: `inventory-eval-${crypto.randomUUID()}`,
      runtime: createRuntime({ retry: { attempts: 1 } }),
      agents: [
        defineAgent({
          name: 'inventory',
          identity: 'Reports warehouse stock.',
          instructions:
            'The current stock of SKU A is 8 units. Report capacity without dispatching.',
          model,
        }),
      ],
    });
    return { room, fixture: { stock: 8 } };
  },
  async beforeAction({ action }) {
    // Prepare scenario-specific environment changes here when needed.
    assert.ok(action.kind === 'say' || action.kind === 'finish');
  },
  async capture({ fixture }) {
    return { stock: fixture?.stock ?? null };
  },
  checks: [
    {
      id: 'inventory-contributes',
      requires: ['simulation'],
      async evaluate({ output }) {
        assert.ok(
          output.exchanges.some((exchange) =>
            exchange.messages.some(
              (message) => message.kind === 'said' && message.from === 'inventory',
            ),
          ),
        );
      },
    },
  ],
  judge: agentJudge({
    id: 'grounded-answer',
    rubric: 'The inventory answer addresses the request and matches the recorded stock.',
    rubricVersion: '1',
    requires: ['simulation', 'stock'],
    select: ({ evidence }) => ({ simulation: evidence.simulation, stock: evidence.stock }),
  }),
  async teardown() {
    // Release additional fixture resources here. The runner owns room cleanup.
  },
});

const report = await runEvals([inventory], {
  model: 'anthropic/claude-sonnet-5',
  judge: createRoomJudge({ model: 'anthropic/claude-sonnet-5' }),
  timeouts: { run: 180_000 },
});
```

`HumanSimulator.decide()` receives declared humans, a detached public room
observation, prior actions, and an abort signal. It returns a `say` or `finish`
action. The model adapter uses an isolated actor room. A deterministic decision
implementation can replay a trajectory in harness tests.

The first implementation sends human messages serially. It awaits ordinary
exchange closure and the optional summary outcome before the next decision.
Final settlement also requires no open exchange, no pending summary, and idle
agents. A simulator's `finish` action does not establish subject success.
Programmatic checks and the judge must pass independently.

`setup`, `beforeAction`, `capture`, and `teardown` provide typed lifecycle
callbacks. Use `setup`'s `defer` or `manage` to register additional cleanup before
fallible allocation. Cases do not provide an interaction loop. Their checks
receive detached, sealed evidence with no live fixture handles.

Use `createJsonFileStore(directory)` to retain results. `regradeEvals` evaluates
retained evidence without replaying the human simulator or subject. It writes a
separate grading report. Invalid judgments, missing evidence, exhausted limits,
and execution errors cannot pass. Timeouts use cooperative cancellation.

The lower-level `defineEval` lifecycle remains available for reusable adapters,
infrastructure tests, and retained-trace grading. New behavioral cases use
`defineRoomEval`. See [the design contract](../../docs/evals.md) for visibility,
settling, calibration, and current limitations.
