# Ambion

**Ambion is a collaboration kernel for independently owned agents and the
people they serve.** It gives domain agents a shared journal, rules for
participation, and a reliable boundary for contributing to a conversation.

[ambionframework.com](https://ambionframework.com) · [documentation](docs/README.md)

An agent owns its instructions, model, tools, and domain expertise. A room
lets those agents work together. An optional assistant selects specialists
and consolidates their work for a person. Applications own their domain data
and the resources their tools use.

## When to use Ambion

**Use Ambion when several domains must contribute to one ongoing application.**
A question such as “Can we promise a Thursday delivery?” can require several
agents. Inventory checks stock. Scheduling checks capacity. Compliance checks
constraints. Each agent uses its own tools and contributes when it has
something useful to add.

**The agent is the unit of modularity.** Each domain can have its own owner,
instructions, model, tools, and evaluations. Agents can improve independently.
Their shared collaboration contract makes their contributions usable together.

**Rooms persist across individual questions.** People arrive and leave.
Specialists join and leave the active membership. Later messages can change
an answer that is still being prepared. The journal preserves these interactions
for the lifetime of its storage.

Ambion serves TypeScript application developers. The application supplies
hosting, agent definitions, credentials, and domain tools. Ambion supplies the
collaboration semantics.

![Independent agents contribute to a shared journal in an ongoing room. New context steers active work. An optional assistant summarizes a closed exchange for later activations, while people can review its original messages.](docs/assets/ambion-exchange.svg)

## The conceptual model

| Concept          | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| Agent definition | Identity, instructions, model, and tools for one domain      |
| Room             | Participants collaborating through one ordered journal       |
| Membership       | An agent's participation and attention within a room         |
| Visit            | A human's speaking identity and presence lifetime            |
| Exchange         | An opening message and the discussion it starts              |
| Activation       | A bounded execution with authority to contribute to the room |

Application code mainly works with definitions, rooms, visits, and exchanges.
Membership changes through room operations. Activation and lease details
belong to the hosting contract. The API calls an agent membership a
_seat_.

## How collaboration works

**The journal is the source of active collaboration and its history.** It
records contributions, presence, membership, execution claims, and exchange
boundaries. Pure rules interpret those facts to determine what may happen
next. A host recovers unfinished collaboration by replaying the journal.

**Agents reason concurrently; the room serializes accepted contributions.**
Ordinary speech carries `readThrough`, the context the activation consumed.
If relevant unread context arrived, the room refuses the stale contribution
and supplies the missing context for reconsideration.

**Attention controls idle agents; new context steers active agents.** Membership
sets which messages activate an idle agent. Active ordinary agents receive new
context between provider requests. Lease renewal extends execution authority
without implying that the agent read new context.

**Silence is a valid result.** An agent can finish without calling `say`.
The runtime adds no acknowledgement to the conversation. Host diagnostics
separate deliberate silence from failures and exhausted attempts.

**Remaining work determines completion.** One room has one open discussion at
a time. Pending work and execution leases determine when it closes. A recorded
close fixes the exchange range. Separate simultaneous discussions use separate
rooms.

**The optional assistant has constrained duties.** It selects reserve agents
when an exchange opens and can summarize a closed discussion. Those executions
receive `seat` or `summarise`, with no ordinary specialist authority. A summary
retains its source range even if a later exchange starts.

**Summaries compact later activations; people can review the discussion.**
Once a closed exchange has a summary, later agent activations read it in place
of the covered source messages. The journal retains those messages, and
`exchange.messages()` lets applications show the original discussion to human
participants. See the [assistant contract](docs/assistant.md#8-summaries-compact-activations-people-can-review-the-discussion).

## Install

Use Node **22.19 or later**. Packages use ESM. Model execution uses the Pi
integration and requires credentials for the chosen provider.

The [local development CLI](packages/cli/README.md) creates team projects and
opens their rooms in OpenTUI. Installing the CLI or the repository requires
Node **26.4 or later**.

The configured registry is GitHub Packages, which requires a token for read
access. Create a [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with `read:packages`, then add this to your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
export GITHUB_TOKEN=…
npm install @ambionframework/ambion
```

The main library includes the journal dependency. Add
`@ambionframework/workspace` when agents need its optional filesystem tools.
See [Contributing](CONTRIBUTING.md) to build and run from source.

## Try the local CLI

**Create a team with `ambion new` and talk to it with `ambion dev`.** Use
Node **26.4 or later**, pnpm 10, and an interactive terminal.

Configure GitHub Packages in your user `~/.npmrc` with the registry and token
lines from [Install](#install). Set `GITHUB_TOKEN` to a classic token with
`read:packages`. After prerelease publication, install the CLI from `next`:

```sh
npm install --global @ambionframework/cli@next
ambion new my-team
cd my-team
pnpm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set ANTHROPIC_API_KEY.
ambion dev
```

The OpenTUI room contains a planner, a reviewer, and your local participant.
Enter sends a question. Scroll with the mouse wheel. Ctrl-C closes the room
and stops Wrangler.

Edit instructions in `src/room.ts`, then restart `ambion dev`.
History remains in `.wrangler/`. Use `ambion dev --port 8788` if port 8787
is occupied.

The generated project configures the registry and uses published packages,
including the Cloudflare adapter. See the [CLI README](packages/cli/README.md)
for model settings, HTTP testing, and resetting local history.

## A small room

This example uses two specialist definitions and no assistant. Each specialist
owns its instructions and model choice. Define ordinary typed tools with
`defineTool` and pass reusable bundles in the separate `bundles` field.
Pass a workspace's `tools()` result in that field.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';

const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  instructions: 'Use the supplied stock facts. State a constraint only when it changes the answer.',
  model: 'anthropic/claude-sonnet-4-5',
});
const scheduling = defineAgent({
  name: 'scheduling',
  identity: 'Checks delivery capacity.',
  instructions:
    'Use the supplied capacity facts. State a constraint only when it changes the answer.',
  model: 'anthropic/claude-sonnet-4-5',
});
const priya = defineHuman({
  name: 'priya',
  identity: 'Coordinates customer deliveries.',
});

const room = await startRoom({
  name: 'delivery',
  goal: 'Check delivery promises against stock and capacity.',
  agents: [inventory, scheduling],
  seats: { inventory: 'broadcast', scheduling: 'broadcast' },
});

try {
  const visit = await room.visit(priya);
  const exchange = await visit.send({
    text: 'We have 12 units in stock and Thursday capacity for 8. Can we promise 10 for Thursday?',
  });
  for (const message of await exchange.messages()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

Supply an `assistant` definition to `startRoom` when the application needs
specialist selection or synthesis. Include every ordinary definition in
`agents`; leave an agent out of `seats` to keep it in the reserve.
`exchange.response()` waits for a summary or a terminal result
without one. Deliberate absence returns `undefined`; revoked or abandoned
summary work rejects the response wait. The application can read
`exchange.messages()` for the discussion in either case.

[`examples/site`](examples/site) demonstrates domain tools, reserve selection,
multiple people, and a shared workspace.

## Hosting and persistence

**Placement, persistence, and tool resources are separate choices.**

| Model                         | Storage                            | Use and support                                                    |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Embedded Node application     | In-memory journals                 | Development, tests, and ephemeral application lifetimes            |
| Persistent Node service       | SQLite through the storage adapter | SQLite adapter and recovery tests; application-managed lifecycle   |
| Separate room and agent hosts | Storage chosen by each host        | JSON protocol extension contract                                   |
| Cloudflare Durable Objects    | Each object's SQLite storage       | Publishable adapter for local CLI use; deployment commands pending |

The host keeps its process alive, supplies definitions again after restart,
and owns model credentials and tool resources. Persisted history alone does
not restart an application. The protocol carries collaboration data; execution
hosts need their own code, credentials, and authorization.

See [Deployment and recovery](docs/deployment.md) for host responsibilities
and the current evidence for each model.

## Boundaries and limits

- Full history remains in storage and replay. Memory and model input can grow
  with room history. Ambion does not promise bounded context or indefinite scale.
- Activation deadlines and retry caps do not impose a total exchange budget.
  Continuing contributions can keep an exchange open.
- Tools can act before a contribution commits. Applications own effect
  idempotency; conversation freshness does not make external effects transactional.
- `abort()` and `stop()` affect the room. An exchange handle does not provide
  independent cancellation of its agents.
- A process crash does not record a person's departure. Hosts reconcile
  durable presence with their actual connections after recovery.
- Subscriptions belong to a running host. Reconnecting clients read durable
  messages and reacquire exchange handles.
- Workspace files remain separate from collaboration history. Shared workspaces
  provide no operating-system isolation between agents or distributed directory ownership.
- Ambient means a room remains available between interactions. Native timers,
  external event subscriptions, and a scheduler ingress API are future work.

The journal does not own domain transactions or credentials. Browser-only
execution, a managed service, and turnkey deployment commands are not provided.

## Read more

[Documentation](docs/README.md) maps the design contracts and hosting guidance.
[Contributing](CONTRIBUTING.md) covers builds and checks.

## License

[Apache 2.0](LICENSE)
