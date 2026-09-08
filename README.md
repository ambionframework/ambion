# Ambion

A minimalist framework for ambient, always-on agents.
[ambionframework.com](https://ambionframework.com)

## The bet

A single agent scales until its context window holds one domain too
many. You have felt the first step: a skill or a tool added for one task
made another task worse. The model reads the window whole, so every
domain in it changes how every other domain behaves. A context window
cannot integrate an unbounded number of domains.

That limit sets the module boundary. A module is a unit one team can
change without impacting other teams doing similar work, and nothing
inside a shared window passes that test. The smallest unit that does is
a whole agent: one context window, one domain, one team that owns it.
The agent is the atomic module of intelligence. Subagents split the
window and keep the boundary inside the parent.

Once the agent is the unit, an application that keeps expanding becomes
many agents, and the problem that matters changes. Routing sends a task
to one agent. A complex task needs several to step in, read what the
others did, and add their part. Every agentic application that expands
in scope discovers this: the problem to solve is agent-to-agent
collaboration.

Ambion is my take on it. Agents share one record, people work in the
room beside them, and the room's assistant writes each person the way
they read, so nobody reads a swarm. They read one message.

## How a room works

Ambion puts agents and people in one room with one shared record. Every
event is a message on that record, and a message wakes the agents it
reaches. [`demos/`](demos) holds real runs with every activation in full.

**Agents are ambient.** An agent waits in its seat and activates when a
message reaches it. A person speaking is one event source. A timer, a
task or another system is an event source of the same kind, and every
one enters as a message. An idle room costs nothing.

**Silence is the default.** An activated agent holds one built-in tool,
`say`. An activation that ends without calling it leaves no mark. A reply
must add something the record does not already hold, and the judgment
lives in the agent's instructions.

**Nobody speaks over what they have not read.** A `say` that raced past
unread messages is refused, and the refusal carries what it missed. The
agent decides again: add something, or stand down. Every message on the
record was written by somebody who had read everything before it.

**A question opens an exchange, and quiet closes it.** The agents that
the question reaches wake in parallel and work it out between them. The
person who asked owns the exchange until it closes, even after they
leave.

**The assistant writes the one message a person reads.** Every room
seats one. A person's definition carries how they read, and when their
exchange closes with more than one agent message, the assistant writes
the summary they read. From the next activation the agents read the
summary in place of the messages it stands for.

```mermaid
flowchart LR
    P((person)) -- "deliver · arrive · leave" --> R[(session record)]
    R -- "wakes by attention" --> A["agents, in parallel"]
    A -- "say" --> R
    R -- "exchange closes" --> D[assistant]
    D -- "one summary" --> R
```

## Example

A shared construction site. Each product is an agent. The people who run
the site visit, ask, and leave.

```ts
import { defineAgent, defineHuman, startSession, visitSession } from '@ambionframework/ambion';

const materials = defineAgent({
  name: 'materials',
  identity: 'Tracks stock and deliveries.',
  instructions: 'Answer from stock_check. Flag a shortfall; otherwise stay quiet.',
  model: 'anthropic/claude-sonnet-4-5',
  tools: [stockCheck],
});
// tasks and timesheet are defineAgent values of the same shape.

const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager. Owns the programme.',
  preferences: 'Lead with the decision Priya has to make. Four sentences at most.',
});

const assistant = defineAgent({
  name: 'assistant',
  identity: 'Writes the one message a person reads.',
  model: 'anthropic/claude-sonnet-4-5',
  instructions: 'Answer what was asked, once, with the facts the answer turns on.',
});

const session = startSession({
  name: 'site',
  goal: 'Run the site: schedule, materials, crew hours.',
  assistant,
  agents: [materials, tasks, timesheet],
});

const visit = await visitSession(session, priya);
await visit.deliver({ text: 'Can I tell the client Thursday for the pour?' });
await session.quiet(); // the room settled, and the assistant wrote Priya her one answer
```

[`examples/site`](examples/site) is the runnable version: three products,
three people, one assistant.

## Install

Ambion publishes to GitHub Packages, which requires a token even to read.
Create a [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with `read:packages`, then add to your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
export GITHUB_TOKEN=…
npm install @ambionframework/ambion
```

## Read on

The design contracts live in [`docs/`](docs): [`agent.md`](docs/agent.md)
for the core, [`exchange.md`](docs/exchange.md) for the exchange,
[`presence.md`](docs/presence.md) for people and visits,
[`assistant.md`](docs/assistant.md) for the assistant,
[`workspace.md`](docs/workspace.md) for the workspace, and
[`roster.md`](docs/roster.md) for a roster that changes while the room
runs. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the build.

## License

[Apache 2.0](LICENSE)
