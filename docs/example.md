# The example: Fast Forward Engine

**One runnable example ships with 0.1.0, and it is an agentic lab
workspace.** It replaces the site example and Relay. It is the room a new
reader opens first, the host the deployment guide describes, the user
interface that drills from a room into one activation, and the evidence
that the release claims hold. The [delivery plan](../planning/next.md)
schedules its construction; the directory `examples/workbench` does not
exist yet.

The specification below is the product description. The sections after it
map the specification onto the kernel and list what the example must show.

## Fast Forward Engine: an agentic lab workspace

A shared workspace where humans and specialized agents collaborate on
electrical engineering, hardware, and electrochemistry: from technical
questions and designs to experiments and measured results.

### Specialized agents

| Agent                   | Scope of responsibility                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Datasheets Agent**    | Find and interpret datasheets, manuals, application notes, and chemical safety data sheets. Compare specifications, identify operating limits, and cite exact sources and revisions.                                  |
| **Design Agent**        | Develop and troubleshoot circuits, assemblies, materials, and formulations. Perform calculations and simulations, propose changes, and explain tradeoffs and failure hypotheses.                                      |
| **Experiments Agent**   | Turn questions into test plans. Define procedures, variables, controls, measurement requirements, and acceptance criteria. Coordinate execution and recommend follow-up tests.                                        |
| **Instruments Agent**   | Configure and operate connected equipment within approved procedures and limits. Check readiness, monitor runs, capture instrument settings and measurements, and request physical setup or intervention from humans. |
| **Data Analysis Agent** | Convert measurements into reproducible results. Check data quality, visualize signals, fit models, quantify uncertainty, and compare runs against expectations.                                                       |

### User-facing assistant

The **Assistant** is the user's primary point of contact. It understands
the request, brings together the right specialists, and communicates the
outcome.

- **Clarify:** Establish the goal, relevant context, and constraints. Ask
  questions only when needed.
- **Select:** Assign the smallest useful set of agents and provide a clear
  brief.
- **Stay available:** Surface meaningful progress, blockers, and requests
  for human input or approval.
- **Steer exceptionally:** Let specialists collaborate directly. Intervene
  only when the conversation stalls, drifts from the goal, or needs a
  decision about scope or ownership.
- **Synthesize:** Return a concise answer covering results, supporting
  evidence, unresolved questions, and recommended next steps. Preserve
  material uncertainty and disagreement.

Technical responsibility remains with the specialists; priorities and
consequential decisions remain with humans.

### Shared workspace

Agents collaborate through shared **projects, designs, test plans, runs,
samples, equipment records, and results**. Scheduling, task ownership, and
history are workspace capabilities.

Users can address a specialist directly or give the Assistant a goal.
Either way, the work produces traceable artifacts and a clear result
without requiring the user to manage every agent interaction.

## How the specification maps onto the kernel

**Every noun in the specification is one of four application concepts or
one resource.** The table names the mechanism and the review item that
delivers it.

| Specification                                | Mechanism                                                                                          | Review item |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| A project                                    | One room per project; rooms persist across questions                                               |             |
| A user                                       | A visit with a definition and reading preferences                                                  |             |
| Five specialized agents                      | Five definitions, each with its own executor; the reserve holds the ones a question does not need  | E1, F10     |
| The Assistant                                | The assistant package's definition, seated at `broadcast`, named as the summary writer, fixed      | D4          |
| "Ask questions only when needed"             | A directed say to the person; the exchange closes as `awaiting` that person                        | E7          |
| "Requests for human input or approval"       | An `awaiting` exchange, and an `approval` step when an instrument tool needs a decision            | E7, F6      |
| "Let specialists collaborate directly"       | Directed says between seats; attention `named` for specialists the Assistant brings in             |             |
| "Synthesize"                                 | The closing activation writes one summary for the person who asked; it cites its sources           | E5          |
| Projects, designs, test plans, runs, results | A SQL resource over one SQLite database, with `query` and `record` tools                           | E4          |
| Datasheets, manuals, safety data sheets      | The directory workspace under `/library`, read through the workspace binding                       | E4          |
| Equipment records and instrument operation   | A simulated instrument resource with readiness, run, and measurement tools, and approval on limits | E6, F6      |
| "Traceable artifacts"                        | `refs` on messages and summaries; provenance on every resource change                              | E5, E6      |
| "History" as a workspace capability          | The journal for collaboration; the resource's own change log keyed by activation for artifacts     | E6          |
| "Scheduling" and "task ownership"            | Application state in the SQL resource; outside the kernel by design                                |             |
| Results and measured data                    | Rows in the results table, with the run and the activation that produced them                      | E6          |

**The kernel owns the collaboration and nothing in the lab.** The example
owns the schema, the library files, the instrument simulation, and the
user interface. A reader who swaps the schema for their own domain keeps
the rooms, the visits, the exchanges, and the drill-down.

## What the example must show

**The example is the release evidence for the claims a reader will test
first.** Each scenario runs on a scripted executor in CI and on a real
provider in the live tier.

| Scenario                                                                             | Claim                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| "Can this regulator supply 350 mA at 85 °C?" answered from a datasheet in `/library` | A specialist works from a shared artifact and cites it |
| The Assistant seats the Design Agent for a balancing circuit and stays silent after  | Selection, silence, and one summary                    |
| A test plan becomes runs, measurements, and a result row                             | Three specialists hand work along through resources    |
| The Instruments Agent asks a person to connect a cell before a run                   | An exchange awaiting a person; an approval step        |
| A person adds a constraint while the Design Agent works                              | Steering and a delta pass                              |
| The host restarts during a run                                                       | Resume, inherited leases, no lost question             |
| A person opens the run's exchange and one activation                                 | The drill-down reads: room, exchange, activation, step |
| The Design Agent runs on the Claude Agent SDK while the rest run on Pi               | Two executor families in one room                      |
| Cost per exchange in the user interface                                              | Usage on every activation                              |

## Layout

**One package, one process, one database, one directory.** The proposed
layout keeps every concern in a file a reader can open in order.

```text
examples/workbench/
  README.md            how to run it, what to look at, what each scenario shows
  package.json
  src/
    definitions.ts     six definitions; executors chosen by environment
    resources.ts       the SQL resource, the library workspace, the instrument
    schema.sql         projects, designs, test_plans, runs, samples, equipment, results
    server.ts          the persistent host: rooms per project, HTTP for the UI
    main.ts            start or resume
  library/             datasheets, manuals, and safety data sheets as text
  ui/                  one page: projects, room, exchange, activation, steps
  test/                the scenarios on the scripted executor
  test/live/           the scenarios on a real provider
```

The `ambion new` Node template derives from this layout with one room, two
definitions, and no resources.
