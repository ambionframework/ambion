# Skills

**A skill is a set of instructions that an agent reads when a task needs
them.** Each skill is a folder in the [agentskills.io](https://agentskills.io)
format: a `SKILL.md` with a name and a description, and any scripts,
references, and assets that the instructions use. The model sees the name
and the description of each skill. It reads the rest when the task matches.

**The skills of an agent are part of its definition.** The host reads them
once with `loadSkills`, before it defines the agent, and gives the set to
the workspace bundle of that agent. Two agents that share a workspace and
every git template still have their own skills.

**Each agent reads its skills from its own home.** At the start of each
respond activation, the workspace makes `~/.skills` in the agent's home
hold the files of the set. The seat reads a skill with `read` and runs a
script with `bash`. Pi, Claude, and Codex seats hold the same workspace
tools, so a skill works the same on each harness.

**A skill can also store macros.** A macro is a compose program that the
model runs by name ([Macros](#macros)).

## Words

| Word      | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| skill     | One folder with a `SKILL.md`, and the scripts, references, and assets beside it    |
| skill set | The skills of one agent, checked and frozen by `loadSkills`                        |
| copy      | The files of a skill set in `~/.skills` in the agent's home                        |
| manifest  | `~/.skills/.manifest`: the path and the blob hash of each file of the copy         |
| script    | A file under `<skill>/scripts/`. The copy makes it executable                      |
| macro     | A file `<skill>/macros/<name>.js`. A seat runs it by name with `compose`           |
| resource  | Any other file of a skill, such as `references/limits.md` or `assets/slab.png`     |
| source    | Where the files come from: `fromDirectory(path)`, or the text of each file by path |

## Write a skill

**A skill set is a folder of skill folders.** The name of each skill folder
is the name of the skill. The folder holds `SKILL.md` and any other files.

```text
agents/surveyor/skills/
  pour-plan/
    SKILL.md
    scripts/
      tonnage.sh
    references/
      limits.md
    assets/
      slab.png
  site-diary/
    SKILL.md
```

**`SKILL.md` starts with YAML frontmatter between two `---` lines.** The
frontmatter ends at the first line that holds `---` alone. The body holds
the instructions. A path in the body is relative to the folder
of the skill.

```markdown
---
name: pour-plan
description: Check a concrete pour plan against the tonnage. Use it when a person asks whether a pour fits the limits.
---

1. Run `scripts/tonnage.sh <volume in m3>` to get the tonnage.
2. Read `references/limits.md` for the limit of one pour.
3. Say whether the pour fits, and cite the limit.
```

**A script is an ordinary file under `scripts/`.** Start it with a `#!`
line. The copy makes it executable, so the seat runs it by its path. The
seat can also run it with an interpreter, such as `bash scripts/tonnage.sh`.

```sh
#!/bin/bash
echo "tonnage for $1 m3: $(( $1 * 24 / 10 )) t"
```

## Give an agent its skills

**`loadSkills(...sources)` reads each source once and checks each skill.** A
source is `fromDirectory(path)`, which reads a folder on the host, or an
object that maps each path to its text. `fromDirectory` reads bytes, so an
asset can be binary. Call `loadSkills` before you define the agent: a skill
that breaks a rule stops the host with an error that names the file.

**`workspace.tools({ skills })` gives the set to one agent.** The bundle
holds a tool for each tool of `workspace.tools()`, with the same name. Its
guidance lists the skills, and its reminder makes the copy.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { claude } from '@ambionframework/claude';
import { pi } from '@ambionframework/pi';
import { fromDirectory, loadSkills, openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/just-bash';

const drive = openWorkspace({ name: 'site', backend: { bash: memoryBackend() } });
const surveyorSkills = await loadSkills(fromDirectory('./agents/surveyor/skills'));
const clerkSkills = await loadSkills({
  'filing/SKILL.md': '---\nname: filing\ndescription: File a site report.\n---\nSteps.\n',
});

const surveyor = defineAgent({
  name: 'surveyor',
  identity: 'Quantity surveyor. Holds the tonnage.',
  executor: claude({
    model: 'claude-sonnet-5',
    instructions: 'Use your skills before you answer.',
    bundles: [drive.tools({ skills: surveyorSkills })],
  }),
});

const clerk = defineAgent({
  name: 'clerk',
  identity: 'Files the site reports.',
  executor: pi({
    model: 'anthropic/claude-sonnet-5',
    instructions: 'File each report the day it arrives.',
    bundles: [drive.tools({ skills: clerkSkills })],
  }),
});
```

**Two agents share skills when they share a set.** Pass the same set to the
bundle of each agent. Each agent still gets its own copy in its own home.

**An agent takes one workspace bundle.** A definition with both
`drive.tools()` and `drive.tools({ skills })` holds each tool twice, and
`defineAgent` refuses it. Give the agent the bundle with skills alone.

**`tools()` with no skills keeps one stable bundle.** Each call with
`skills` returns a new bundle, whose tools run the tools of `tools()`. `tools` throws when
`skills` is a value that `loadSkills` did not make.

### Several sources

**`loadSkills` takes any number of sources and merges their files into
one set.** A host uses it to put the skills of a template beside the skills
of an agent. The merge runs before the checks, so the set stays sorted and
its manifest has one list.

```ts
const skills = await loadSkills(
  fromDirectory('./agents/surveyor/skills'),
  fromDirectory('./templates/server/skills'),
);
```

**One skill folder can come from one source only.** Two sources that hold
the same folder fail with `Skill set: the skill '<name>' is in source <i>
and source <j>.` The ordinals start at 1, in the order of the arguments.
A call with no source fails with `Skill set: the source holds no skill.`

## The rules that `loadSkills` checks

**`loadSkills` applies the rules of agentskills.io, and refuses a set that
breaks one.** The error starts with `Skill set:` and names the file.

| Rule                                                                                        | Refused example                   |
| ------------------------------------------------------------------------------------------- | --------------------------------- |
| Each path is relative, with no empty, `.`, or `..` segment and no backslash                 | `a/../b/SKILL.md`                 |
| Each file is inside a skill folder                                                          | `README.md` at the root           |
| Each skill folder holds a `SKILL.md`                                                        | `notes/draft.md` with no SKILL.md |
| `SKILL.md` is UTF-8 text that starts with frontmatter between two `---` lines               | A body with no frontmatter        |
| The frontmatter is a YAML mapping                                                           | `- a`                             |
| `name` equals the folder name                                                               | `name: b` in the folder `a`       |
| `name` has 1 to 64 characters of `a-z`, `0-9`, and single hyphens, with no hyphen at an end | `Pour`, `a--b`, `-a`              |
| `description` is text that is not blank, of at most 1024 characters                         | No `description`                  |
| `compatibility`, when present, is text of at most 500 characters                            | 501 characters                    |
| Each macro file passes the rules of [the file format](#the-file-format)                     | A `macros/x.js` with no header    |
| The set holds at least one skill                                                            | An empty folder                   |

**Other frontmatter fields stay in the file, and the room reads none of
them.** `license`, `metadata`, and `allowed-tools` reach the model only when
it reads `SKILL.md`. The workspace does not limit the tools of a seat by
`allowed-tools`.

## What the model reads

**The guidance of the bundle lists each skill.** `skillGuidance` writes the
list as XML, and adds two lines about the folder of the skills. The guidance
goes in the system prompt of every activation, after the guidance of the
workspace tools.

```text
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>pour-plan</name>
    <description>Check a concrete pour plan against the tonnage. Use it when a person asks whether a pour fits the limits.</description>
    <location>~/.skills/pour-plan/SKILL.md</location>
  </skill>
</available_skills>
Your skills are in ~/.skills. The folder of a skill also holds its scripts and
resources. Read a file with read, and run a script with bash.
```

**The location starts with `~`.** `read` and `bash` resolve `~` to the home
of the calling agent. The guidance is fixed when the agent is defined, and a
workstation account gets its home from the server, so the guidance does not
name the absolute path.

## The copy in the home

**Each respond activation makes the copy hold the set.** The reminder of the
bundle queues the copy step on the bash resource, and then gives the process
reminder ([Reminders](processes.md#reminders)). A summarize activation makes
no copy: the executor calls no reminder for it.

**A matching manifest costs one read.** This is the usual case. Another
manifest, or none, costs one write for each file, and one `chmod` command when
the set has a script. This happens at the first activation of the agent,
after the set changes, and after the manifest goes.

**The copy ends before the first tool call of the activation.** The bash
resource runs its operations in order, and the reminder queues the copy
before the model makes a request. The reminder does not wait for the
copy, so the 5-second bound of a reminder does not cut it. A copy that takes
more than 5 seconds delays the process reminder behind it, and the process
list of that one activation is lost.

**The manifest is written last.** A copy that fails, or that a crash cuts,
leaves no manifest. The next respond activation writes the whole copy
again. A failed copy shows to the model only as a `read` that finds no
file.

**The copy step reads nothing but the manifest.** An agent that edits a
file of its copy, and leaves the manifest, keeps the edit until the set
changes or the manifest goes. Remove `~/.skills/.manifest` to restore the
copy at the next activation.

**A run with no reminder copies at its first tool call.** Pi's `runAgent`
runs an agent outside a room and resolves no reminder. Each tool of the
bundle then queues the copy before its own operation, when the bundle has not
copied for that agent in this process.

## Scripts and resources

**A script runs in the shell of the bash backend, as the agent.**

| Backend                  | What a script can run                                   |
| ------------------------ | ------------------------------------------------------- |
| `memoryBackend`          | The commands that just-bash implements, in memory       |
| `directoryBackend`       | The commands that just-bash implements, over the folder |
| The workstation over SSH | The programs of the server, in the agent's account      |

**Write each script for the backend that runs it.** A script that needs a
program the backend does not have fails with the error of the shell. The
`compatibility` field can state what a skill needs, and the model reads it
in `SKILL.md`.

**A resource is a file that the seat reads.** `read` gives the text of a
reference. An asset can be binary, and the copy keeps its bytes. A script
or a command of the seat reads an asset by its path in the copy.

## Macros

**A macro is a compose program that a skill stores as data.** Macros are
the main use of `compose`. The model runs a macro by name with arguments and
writes no code. The macro declares the tools that it uses, and the room checks
the arguments before anything runs. [Compose](compose.md) holds the tool that
runs it.

**A macro saves the model from writing the same code in each exchange.** Each
line of code costs output tokens, and each copy can differ from the last one
by a typo or a changed query. A script under `scripts/` repeats a procedure for
the shell alone: it cannot reach `sql`, `snapshot`, or any other tool of the
room. A macro reaches those tools, and the code never passes through the model.

A skill holds a macro in a file. The file declares the tools and the
arguments of the macro, and holds the code.

```js
/*---
description: Snapshot the files of every run with a label. Returns the count and the refs.
uses: [sql, snapshot]
args:
  type: object
  properties: { label: { type: string } }
  required: [label]
---*/
const runs = await tools.sql({
  sql: 'SELECT path FROM runs WHERE label = ?',
  params: [args.label],
  rows: 500,
});
const { refs } = await tools.snapshot({ paths: runs.rows.map((row) => row.path) });
return { runs: runs.count, refs };
```

This file is `lab-drift/macros/snapshot-drift.js`. `SKILL.md` names the macro
and does not quote it. The name is `<skill>/<macro>`.

```markdown
1. Run the macro `lab-drift/snapshot-drift` with `{ "label": "drift" }`.
2. Cite the refs in your say.
```

The guidance of `compose` lists the macro with its description
([Compose](compose.md#guidance)). The model runs it with one call:

```js
compose({ macro: 'lab-drift/snapshot-drift', args: { label: 'drift' } });
```

The rows and the paths stay in the compose call. The model reads the
returned value alone, and then cites the refs in a `say`:

```json
{ "runs": 2, "refs": ["ambion://workspace/lab/snapshot/<sha256>/shared/a.md", "..."] }
```

**The code runs under the tools of `uses` alone.** `uses` belongs to the
file. `composeExtension` checks it once, when the definition is made, and
the model cannot widen it. A macro binds only tools that the seat holds, so
its authority is the authority of a direct call.

**The code is frozen at definition.** `compose` finds the macro in the
skill set of the definition and never reads `~/.skills`. An edit of the copy
does not change what runs.

**A macro call is a compose call.** Each nested call is an ordinary tool
call with its schema, its checks, its provenance, and its steps. The ledger,
the limits, and the audit log apply.

**One skill set fits every seat.** A definition that `describeExecutor`
builds with no `compose` extension ignores the macros and lists none. The
executor packages always add the extension.

### The file format

**A macro file sits in `<skill>/macros/<name>.js`.** The agentskills.io
format allows any folder in a skill, so other harnesses ignore this one.
A file in `macros/` that does not end in `.js` is a resource of the skill.

**The file opens with a YAML block comment, and then the body.** The header
lies between a `/*---` line and a `---*/` line. `loadSkills` strips the
comment marks and reads the lines with the frontmatter parser of `SKILL.md`.
The body is the body of the async function that `compose` runs, with one
more global, `args` ([Compose](compose.md#the-runtime)).

**The header has three fields, and `loadSkills` refuses any other.**

| Field         | Rule                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `description` | Text that is not blank, of at most 1024 characters. The guidance shows it |
| `uses`        | A non-empty list of tool names. The macro binds these tools alone         |
| `args`        | Required. A JSON Schema object that the arguments must satisfy            |

**`loadSkills` refuses a macro file that breaks a rule.** The error starts
with `Skill set:` and names the file.

| Rule                                                                            | Refused example                  |
| ------------------------------------------------------------------------------- | -------------------------------- |
| The file is UTF-8 text that starts with a header in a `/*---` and `---*/` block | A body with no header            |
| The header is a YAML mapping with the fields above and no other field           | `when: always`                   |
| The name of the file has the rules of a skill name, before `.js`                | `Snap_Shot.js`, `a--b.js`        |
| The file sits directly in `macros/`                                             | `macros/more/one.js`             |
| `description` and `uses` follow the table above                                 | `uses: []`                       |
| `args` is JSON Schema of draft 2020-12 with the keywords that the check reads   | `type: banana`, `$ref`, `format` |

**The check of `args` refuses a keyword that `Check` ignores.** TypeBox
ignores a keyword that it does not know, so a schema with one would accept
every value. The schema must satisfy the meta-schema of draft 2020-12, and
every keyword must be in this list. The list omits `$ref`, `$defs`, `$id`,
`$anchor`, and `format`.

| Kind              | Keywords                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Types and values  | `type`, `enum`, `const`, `required`, `dependentRequired`                                              |
| Numbers           | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`                            |
| Text              | `minLength`, `maxLength`, `pattern`                                                                   |
| Lists and objects | `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `minContains`, `maxContains` |
| Schemas inside    | `properties`, `patternProperties`, `additionalProperties`, `items`, `prefixItems`, `contains`         |
| Combinations      | `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, `dependentSchemas`, `propertyNames`           |
| Open objects      | `unevaluatedProperties`, `unevaluatedItems`                                                           |
| Notes             | `title`, `description`, `default`, `examples`, `$comment`                                             |

**`loadSkills` keeps the text and the hash of each macro.** The set holds
`set.macros`. Each entry has the name, the description, `uses`, the `args`
schema, the body as text, and the git blob hash of the whole file.
`Object.freeze` does not freeze the bytes of a file, so the set keeps the
text of the macro. The copy in `~/.skills` holds the file too.

**`workspace.tools({ skills })` puts the macros on the bundle.** The field
is `ToolBundle.macros`. It holds `ComposeMacro` values, and
`composeMacro(fields)` of `@ambionframework/compose` checks the fields and gives a frozen copy. A bundle
only carries the data.

### How compose runs a macro

**`composeExtension` checks the macros of a seat that has the `compose` tool.** It
collects the macros of every bundle. It refuses a macro that names a tool
which the catalog lacks. The catalog holds the tools of the seat and the room
tools. A tool with `compose: false` is not in the catalog. It refuses two
macros with one name. The error is an `AmbionError` with the code
`invalid_tool`.

**`compose` takes a macro in place of `uses` and `code`.** The model gives
`macro` and an optional `args`. These steps run in this order:

1. Refuse a call that mixes `macro` with `uses` or `code`.
2. Refuse a name that no macro holds. The error lists the names.
3. Take absent `args` as `{}`. Refuse `args` that are not JSON.
4. Check `args` against the schema of the macro. The refusal gives the
   path and the rule of each fault.
5. Ask `approve` with the name, the hash, and the `args`
   ([Approval](compose.md#approval)).
6. Evaluate the stored code under the stored `uses`.

A refusal at steps 1 to 4 has no ledger, no approval, and no effect. A
denial at step 5 has no ledger and no effect. From step 6 the call is an
ordinary compose call: the nested calls, the ledger, the limits, and the
result.

### Review a macro

**The seat that holds the skill reads it.** The copy in
`~/.skills/<skill>/macros/<name>.js` holds the whole file. `read` gives the
text, so the agent sees the header and the body before it runs the macro.
The scripts and the resources of the skill sit beside it.

**The hash of the approval equals the hash of the file.** The `hash` that
`approve` receives is the blob hash that `loadSkills` computes from the
bytes of the file: SHA-1 over `blob <size>`, a zero byte, and the bytes.
`git hash-object <file>` gives the same value for the same bytes.
`~/.skills/.manifest` lists the same value for the path
`<skill>/macros/<name>.js`. A reviewer who reads the bytes can match them to
the approval. Any change to the file gives another hash.

**The copy is editable, and the run is not.** A review of the copy reads
what the agent can change. An edit shows when the blob hash of the copied
file differs from the hash in the manifest, or from the hash that `approve`
receives. On `memoryBackend` and `directoryBackend`, the manifest is a file
of the copy, so an agent can change it too. The hash from the host is the
reference.

**A host reviews the source.** The skill set is a folder in the repository
of the host, so a pull request review covers each macro and each script. The
host can hold the hash of a reviewed file and let `approve` allow that
hash alone:

```ts
const reviewed = new Map([['lab-drift/snapshot-drift', blobHashOfReviewedFile]]);

compose: {
  runtime,
  approve: (request) =>
    'macro' in request && reviewed.get(request.macro) === request.hash ? 'allow' : 'deny',
},
```

An edit of the file in the repository gives another hash, and `approve`
denies it until the host records the new hash after a review.

### Write a macro

**A macro sends model data to tools, so treat it as a public API.** The model
chooses `args`.

- **Check `args` with the schema.** `compose` checks them before it runs any
  code. Close the object with `additionalProperties: false`, and bound
  numbers and text.
- **Pass SQL values through `params`.** The `params` field binds each value
  to a `?` placeholder, so a quote in an argument cannot change the
  statement ([Query the shared database](sql.md#query-the-shared-database)).
  Never join `args` into the text of a statement.
- **Quote a value that goes into a shell command.** Pass it to `bash` as a
  quoted word.
- **Return only what the model needs.** The model reads the returned value
  alone. The value must be JSON and fit `compose.limits.bytes`.
- **Keep `uses` minimal.** List the tools that the code calls. Each name is
  authority that the macro holds.
- **Write the work in the body.** A body that runs a script of `~/.skills`
  through `bash` runs the editable copy.
- **Reach a process through the `fetch` tool.** The guest has no global
  `fetch`. A macro that lists `fetch` in `uses` calls
  `tools.fetch({ process, path })` and reads its declared output.

## Separation and trust

**The copy of each agent is in its own home.** What protects it depends on
the backend.

| Backend                  | Who can change the copy of `surveyor`                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `memoryBackend`          | Every agent of the workspace. The backends share one filesystem with no owners |
| `directoryBackend`       | Every agent of the workspace, and every host process that can write the folder |
| The workstation over SSH | `surveyor` alone. Each home is mode `0700` for its own account                 |

**The set in the definition does not change.** An edit of the copy lasts
until the copy step writes it again. [Trust](trust.md#what-the-kernel-does-not-defend)
states what the kernel does not defend.

### What a macro keeps, and what it does not

| Part                                | Protected                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| The body, `uses`, and `args` schema | Yes. They come from the set, and `approve` sees the hash                  |
| A script that the body runs by path | No. `bash ~/.skills/<skill>/scripts/x.sh` runs the editable copy          |
| `SKILL.md`                          | No. The copy decides which macro the model runs, and with which arguments |

## Skills and git templates

**A skill tells an agent how to do a task, and a git template gives it
material to start from.** Use each for its own job.

| Question                     | Skill                                  | Git template                                 |
| ---------------------------- | -------------------------------------- | -------------------------------------------- |
| Whose is it                  | One agent's, from its definition       | Every agent's, from the git backend          |
| Does the agent change it     | No. The copy step restores it          | Yes. The agent forks it and changes the fork |
| How the model finds it       | The guidance lists it every activation | `repos` lists it when the agent asks         |
| What the agent makes from it | Nothing. The agent follows it          | A repository of its own                      |

**A skill can tell an agent to fork a template.** The body of `SKILL.md`
names the template and the steps: `fork` it, change the clone, and push.
See [Git](git.md).

**A template can ship a skill.** A template can hold a `skills/`
folder with a skill and its macros. The host loads
that folder from its own copy of the template, with `loadSkills`. An edit
in the fork of an agent changes nothing that runs
([example](../examples/workbench/docs/sensors.md#load-the-skills-of-a-template)).

## Limits

- **The model finds a skill by its description alone.** The room gives no
  command that invokes a skill by name.
- **`loadSkills` sets no size limit.** Each file of the set is in the
  memory of the host, and each copy writes every file.
- **A macro cannot call a macro.** `tools` binds native tools alone.
- **The free `code` form stays.** The guidance asks the model to run a macro
  when a skill names one. The model can still write code.
- **No agent writes a macro of its own.** A macro comes from a skill set that
  the host loads.
- **No tool reviews the skills of another agent.** The kernel does not
  defend this ([Trust](trust.md#what-the-kernel-does-not-defend)).
