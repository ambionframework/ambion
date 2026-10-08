# Git for everything

**This page is a design. No package implements it yet.** It describes how
an application keeps the harness of its agents in git, how each agent
edits its own harness, how an edit takes effect at the next activation,
and how the agents merge a new release at startup. Each section names what
exists today and what must be added.

**The harness is everything that shapes how an agent works.** It is the
instructions and identity text, the skills, the macros of each skill, and
their scripts and references. A git repository holds it. Before each
activation, the host loads the definition of the seat from the tip of
that repository.

## Decisions

- **Each agent can edit every part of its own harness.** Its prompts,
  instructions, skills, and macros are files in a repository that the
  agent owns. The agent changes them with ordinary git.
- **Tools and credentials stay in host code.** No agent edits them. An
  edit can change how an agent works, and never what it can touch.
- **An edit takes effect at the next activation of the agent.** The room
  asks the host for the definition of a seat before each activation. An
  activation in progress never changes.
- **The agents merge a new release at startup.** When the source of the
  harness is newer than an agent's harness, that agent merges the release
  into its own repository and resolves the conflicts.
- **The source repository stays the one truth.** A developer recovers the
  edits of each agent and folds them into the source for the next release.

## What the harness holds

| In the harness repository                         | In host code, not editable |
| ------------------------------------------------- | -------------------------- |
| `agents/<name>/instructions.md`, the instructions | Tools and tool bundles     |
| `agents/<name>/identity.md`, the identity         | Credentials                |
| `skills/<skill>/SKILL.md`, the skill text         | Models and executors       |
| `skills/<skill>/macros/<name>.js`, the macros     | Limits and the roster      |
| `skills/<skill>/` scripts and references          | The canvas and its rooms   |

**The folder layout is a convention of the host.** `defineAgent` takes
strings and a skill set. The host reads the files and builds each
definition, so the layout adds no stored format.

**A macro cannot widen what an agent can touch.** A macro binds only the
tools in its `uses`, and each must be a tool of the seat
([Macros](macros.md)). An edited macro chains the same tools in another
order.

## The repositories

**Two kinds of repository use the git backend as it is
([Git](git.md)).**

| Repository          | Holds                                    | Who writes                |
| ------------------- | ---------------------------------------- | ------------------------- |
| `templates/harness` | The current release of the harness       | The host, by registration |
| `<agent>/harness`   | The harness of one agent, with its edits | That agent alone          |

**`templates/harness` is the release channel.** The host registers it
from the harness folder of the release. A changed folder fast-forwards
the template to a new commit, and an equal folder writes nothing
([Templates](git.md#templates)). No agent can push to it.

**`<agent>/harness` is a fork of the template.** The host prepares it
before the first activation with `git.use(agent, (env) =>
env.fork('templates/harness', 'harness'))`. A fork shares the history of
the template, so a later merge of a new release has a common base.

**Each agent loads its definition from its own fork.** An edit to a
shared skill changes the copy of one agent. Text that one agent writes
never enters the prompt of another agent. A macro that one agent writes
runs only under the tools of that agent.

## Edit the harness

**An agent edits its harness like any other repository.** It clones its
fork, edits a file, commits, and pushes. The guidance of the agent states
three rules:

1. Push each edit. On `memoryBackend`, a commit that is not pushed is
   lost at a restart ([Persistence](git.md#persistence)).
2. Give the reason in the commit message, and cite the exchange that
   showed the need with a commit ref or a message ref.
3. Expect the edit to take effect at the next activation.

**The copy in `~/.skills` is not the harness.** An edit of that copy
changes nothing that runs, and the copy step can restore it
([Skills](skills.md#the-copy-in-the-home)). The fork is the place for an
edit that must last.

## Load at each activation

**The room asks the host for the definition before each activation.** A
new room option, `definitionFor(seat, current)`, returns the definition
for the next activation of a seat. `openCanvas` takes the same option and
passes it to `startRoom` and `resumeRoom` of each row, breakout rooms
included. This is a kernel change: today the room binds each definition
once per run.

```mermaid
sequenceDiagram
  participant R as Room
  participant H as Host
  participant F as agent/harness
  participant E as Executor
  R->>H: definitionFor(seat, current)
  H->>F: resolve the tip
  alt the tip is the loaded commit
    H-->>R: current
  else a new commit
    H->>F: read the files of the commit
    H->>H: loadSkills, then defineAgent
    H-->>R: the new definition, or current with a refusal reminder
  end
  R->>E: the activation, on the returned definition
```

**An unchanged tip costs one resolve.** The host caches the definition by
commit. It reads the files and builds a definition only when the tip
moves.

**The runner asks for the definition when it takes an activation.** The
runner of a seat already reads the definition once for each activation
(`execution/runner.ts`). The seat context and the connector request then
hold a function that returns the definition, and `portFor` binds it to
`definitionFor`. The seat keeps one port for the run, so its queue of
activations stays. An activation in progress keeps its definition. Two
activations of one exchange can run on two commits.

**Only the texts, the skills, and the macros change.** The room accepts
a returned definition only when `captureAgent` accepts it and these fields
equal the current ones: `name`, `identity`, `executor.kind`,
`activationTokenLimit`, `estimateTokens`, and the tool names. Otherwise it
keeps the current definition. The room reads those fields outside the
port, and the journal records the name and the identity in the cast. An
edit of `identity.md` therefore takes effect at the next start.

**A tip that does not load leaves the current definition.** The host
returns the current definition with a reminder that names the refused
commit and the error of `loadSkills` or `defineAgent`. The agent reads the
error at that activation and can push a fix.

**The call has a time bound.** A call that fails or passes the bound
leaves the current definition, as the 5-second bound of a reminder does.

**Each executor must carry the new text into its session.**

| Executor | A changed agent part in a resumed session                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi       | Works: the harness renders the prompt before each request ([Pi](pi.md))                                                                                                         |
| Claude   | Works: the agent part goes at the head of the first message of a resumed session ([Claude](claude.md))                                                                          |
| Codex    | Missing: `thread/start` fixes `baseInstructions`. The executor must compare the agent part as it compares the tools, and start a new thread when it differs ([Codex](codex.md)) |

**The record and the promise do not change.** The option adds no journal
body, and the cast keeps the name and the identity. A new optional field
of the room options is additive.

**The host can pin a seat to one commit.** A pin makes `definitionFor`
return that commit whatever the tip is. A person uses it to stop a bad
edit until the agent fixes it.

## Startup

**A release still lands at a start.** A new release comes with new host
code, so the host restarts. The agents merge the release at that start.
Their own edits between two starts need no merge: each one loads at the
next activation.

```mermaid
sequenceDiagram
  participant H as Host
  participant T as templates/harness
  participant F as agent/harness
  participant R as Startup room
  participant A as Agent
  H->>T: register the release folder
  H->>F: read the tip and its trailer
  alt the trailer names the template tip
    H->>H: load the tip at the first activation
  else the release is newer
    H->>R: post "merge the release"
    R->>A: activation on the last good harness
    A->>F: merge the template, resolve, push with the trailer
    H->>H: load the first commit that loads
  end
  H->>H: resume the application canvas
```

**The host detects a lagging fork from a trailer.** Each merge commit of
an agent ends with the line `Release: <template commit>`. The release of
a fork is the commit that the latest trailer names, or the template
commit that the fork came from. The host walks the first parents of the
tip with `show` to find it, and compares it with the tip of the
template.

**The agents merge in a startup room.** The host opens a second canvas,
`harness`, on the same canvas store. Its one root room seats each agent
whose fork lags. Each agent runs on its last good harness, so the agent
that resolves a conflict has the instructions under which it made the
edit.

**Each agent merges its own fork.** It fetches `templates/harness`,
merges it, and resolves each conflict with its commit messages and the
exchanges they cite. It checks that each skill still loads, then pushes
with the trailer. Agents that edited the same shared skill can talk in
the room before they push.

**At the start, the host loads the first rung that loads, for each
agent.**

1. The merged tip of the fork.
2. The last commit that loaded for that agent.
3. The release folder.

**The last good commit can fail on new host code.** A macro can name a
tool that the release removed, and `loadSkills` or `defineAgent` then
refuses it. The release folder always loads, because the developer tested
it with that host code.

**A merge that fails is kept.** On a deadline or an `exhausted` exchange,
the host loads the next rung for that agent and posts the outcome to the
startup room. The fork keeps what the agent pushed. The agent can finish
the merge later, and the merged tip loads at its next activation. The
startup room is the record of each merge.

**The release keeps each agent name.** A breakout row whose definition
is gone stays `running` at `resume` ([Canvas](canvas.md)).

## Record the version

**The trace records which harness ran each activation.** The host wraps
its `TraceLogger` and adds the loaded commit of the seat and the release
to each step. The commit can change from one activation to the next, so
the trace is the one place that records it. A step already names the room, the seat, the activation, and
the exchange ([Executors](executors.md)). The host stores the trace,
because a restart keeps none.

**The host keeps one log entry for each load.** The entry holds the
seat, the commit, and the outcome: loaded, refused with the error, or
pinned.

**The journal holds nothing new.** It stays the record of what the room
decided.

## Fold the edits back into the source

**The fold is a three-way apply onto the release tag.** The commits of
`templates/harness` come from registration, so the source repository does
not hold them. The tree of the template commit equals the release folder
byte for byte, so it is an exact base:

```sh
git checkout -b harvest/<agent> v<release>
git diff <template commit> <agent tip> | git apply -3 --directory=harness
```

**The developer folds one agent at a time.** Two agents that edited the
same shared skill give two branches. The developer merges them in the
source repository and picks one text for the next release.

**The host exports each fork.** On a workstation, the developer fetches
over SSH. With `justGitBackend`, the server runs in the host's process,
so a host script clones each fork and writes a git bundle.

## Trust

| Attempt                                       | Result                                        |
| --------------------------------------------- | --------------------------------------------- |
| Edit its own instructions, skills, or macros  | Allowed; takes effect at the next activation  |
| Push to another agent's harness               | Refused: no write credential                  |
| Push to `templates/harness`                   | Refused: read-only                            |
| Change a tool or a credential                 | Not possible: host code                       |
| Delete every file of its harness              | Refused at load; the current definition stays |
| Write text that enters another agent's prompt | Not possible: each agent loads its own fork   |

**Use this design in a room of trusted agents.** An agent rewrites its own
instructions, and the edit applies at once. A prompt injection that
reaches an agent can persist through its harness until a person pins the
seat. A room open to untrusted agents loads the release
folder alone ([Trust](trust.md)).

## What must be added

| Piece                                           | State                               |
| ----------------------------------------------- | ----------------------------------- |
| Register `templates/harness`, fork it per agent | Works today                         |
| Load a definition from a checkout of a fork     | Works today: clone, `fromDirectory` |
| Read the files of a commit from the host        | Missing: `GitEnv` has no file read  |
| `definitionFor` in the room and the canvas      | Missing: a kernel change            |
| A new thread on a changed agent part (Codex)    | Missing: executor code              |
| The trailer check, the startup room, the rungs  | Missing: host code                  |
| The load cache, the refusal reminder, the pin   | Missing: host code                  |
| The trace stamp and the load log                | Missing: host code                  |
| The export of each fork for the developer       | Missing: a host script              |

**One kernel change is needed: `definitionFor`.** It reverses the
decision in `planning/backlog.md` that the definition set is fixed for
each run. Each other piece is host code or an additive method of
`GitEnv`.
