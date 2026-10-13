# The git backend

**`@ambionframework/just-bash/git` implements this page.** The contract
lives in the root entry of `@ambionframework/workspace`, and the name
rules and the template helpers live in `@ambionframework/workspace/git`.
The [package guide](../packages/just-bash/README.md#the-git-backend) shows
the options.

**A git backend hosts the repositories of one workspace.** A host
registers read-only templates on it. A person asks an agent to start from
a template. The agent forks the template, clones the fork into its home,
edits the files, commits, and pushes. The push persists the edits across a
restart of the host.

**Two backends implement the contract.** `justGitBackend` runs a
[`just-git`](https://github.com/blindmansion/just-git) server in the host's
process, and it serves the just-bash backends. `workstationGitBackend` in
`@ambionframework/workstation` keeps the repositories in one account on
the [workstation](workstation.md), and it serves the agents of that
server over SSH ([Workstation git](workstation-git.md)). `gitConformance`
holds the contract, so a later implementation meets the same behavior.

## What the backend gives an agent

| Operation           | How the agent does it                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Find a template     | The `repos` tool: each template with its description and clone URL                                |
| Fork a template     | The `fork` tool: a fork in the agent's own namespace                                              |
| Clone into the home | `git clone <url> <path>` in `bash` for any repository, or `fork` with `clone` for a writable fork |
| Edit                | The `read`, `write`, `edit`, and `apply_patch` tools, or `bash`                                   |
| Work on a branch    | Ordinary `git` in `bash`: `switch -c`, `add`, `commit`, `merge`                                   |
| Persist the edits   | `git push origin <branch>`                                                                        |
| Review a peer       | `git clone` the peer's fork in `bash`                                                             |
| Cite a commit       | A commit ref with the full hash from `git rev-parse`, in `refs`                                   |

## Prompt an agent

**A person names the template and the result, and the agent does the
rest.** [The guidance](#the-guidance) states the namespaces and the rule
that a push persists the edits. An instruction needs no git commands and
no URL.

> Start a report from the `weekly-report` template. Fill in this week's
> numbers from `~/data/week.csv`, and push it on a branch named `week-39`.

**The agent then makes five calls.**

1. `fork`, with source `templates/weekly-report`, name `report`, and
   clone `~/report`. The tool forks the template to `analyst/report` and
   clones the fork into `~/report`.
2. `bash` with `cd ~/report && git switch -c week-39`.
3. `edit` on `~/report/report.md`, one call or more.
4. `bash` with `cd ~/report && git add -A && git commit -m "Week 39"`.
5. `bash` with `cd ~/report && git push origin week-39`.

**A later activation continues from the fork.** It uses the working copy
that is still in the home, or it clones the fork again
([Persistence](#persistence)).

## The contract

**`git` is a third backend kind, beside `bash` and `sql`.** The
`BashBackend` of [Workspace](workspace.md#open-one-resource) gets an
optional `git`. A workspace with no git backend has no `repos`
tool and no `fork` tool, and its shell keeps the local `git`.

**The root entry of `@ambionframework/workspace` holds the contract.** It
imports no git library, the same as `SqlBackend`. The file is
`packages/workspace/src/git-backend.ts`, and it holds types only.

**A refusal is an outcome, and a fault rejects.** A source that does not
exist, a name that is taken, and a name that the server refuses are
`ok: false` outcomes. A fault of the storage or of the server, and an
abort, reject. `SqlEnv.run` follows the same rule.

**A `name_taken` outcome also waits until the fork can be cloned.** A
`fork` call that repeats after a timeout finds the fork of the first call.
It resolves when that fork can be cloned, the same as a new fork.

**The backend registers its templates before its first operation.**
`openWorkspace` is synchronous, and a backend has no open step. The first
`connect` of the git resource, and the first call of `credentialFor`, await
one registration. A failed registration rejects
that operation with an error that names the template. The next operation
tries again. Host code that wants the error at start calls
`lab.git.use(lab.mirrorAgent, (env) => env.list())`.

**A bash backend takes its git backend as an option.** The option has
the git backend type of the package of the bash backend. `memoryBackend`
and `directoryBackend` take a `JustGitBackend`, and `workstationBackend`
takes a `WorkstationGitBackend`. The bash backend reads the `access` of
that git backend at each `connect`, with no cast. A git backend of another
package is a compile error.

**The core knows no access type.** Each git backend type of a package adds
an `access` with the wire shape of its own transport. Only the bash backend
of the same package reads it, so `GitBackend` in the core holds no
`access`. The bash backend sets `BashBackend.git` from its option.

**`openWorkspace` opens `bash.git` under an owner of its own.** A bash
backend with no `git` gives a workspace with no `repos` or `fork` tool.
`openWorkspace` runs no check of the pair.

**`Workspace.git` is the owner of the git backend, for host code.** It is
the same as `Workspace.sql`.

## Repositories and their names

**A repository ID has two parts: a namespace and a name.** Agents and the
host use IDs. Each implementation maps an ID to a URL of its own.

| Namespace   | Holds                   | Who can push |
| ----------- | ----------------------- | ------------ |
| `templates` | The read-only templates | Nobody       |
| `shared`    | Shared repositories     | Every agent  |
| `<agent>`   | The forks of that agent | That agent   |

**A name has 1 to 64 characters.** It starts with a lowercase letter or a
digit, and the rest are lowercase letters, digits, `.`, `_`, and `-`. An
agent name matches `^[a-z][a-z0-9-]*$`, so it holds no `.`.

**`templates` and `shared` are reserved names.** Every git backend refuses
an agent with either name, in `connect` and in each credential call. A backend can
reserve more names for its own storage.

**`justGitBackend` keeps the source of each template in
`template-sources`.** The name is a storage detail of that backend. It
refuses an agent named `template-sources`, `repos` does not list the
namespace, and no agent holds a credential for it. An agent forks a
template.

## Templates

**A template is a repository that only its registration changes.** No
credential grants write on it. `justGitBackend` also refuses every push to a
template in its pre-receive hook.

**The host registers each template with a description and a source.**

```ts
templates: {
  'weekly-report': {
    description: 'A weekly status report: numbers, risks, and next steps.',
    source: fromDirectory('./templates/weekly-report'),
  },
},
```

- **`source`** is `fromDirectory(path)`, which reads a directory on the
  Ambion host, or a plain object that maps paths to text.
  [Registration](#templates) states what each one reads.
- **`description`** is optional. It is one or two sentences of plain text,
  and `repos` shows it. A person names the kind of work, and the agent
  finds the template that fits.

**One function holds the decisions of registration, and it resumes after a
crash.** `registerRepositories` of `@ambionframework/workspace/git` runs
the templates, then the shared repositories, each in name order. A backend
supplies the storage steps of `RegistrationSteps` and takes no decision of
registration. It loads no git library.

- **A name must pass the name rule.** The error reads `'<name>' is not a
valid template name.` or `'<name>' is not a valid shared repository
name.` The function reads no source before it checks the name.
- **A source path stays inside the repository.** A path with an empty
  part, `.`, `..`, or `.git` leaves the root. The error names the kind,
  the repository, and the path. Both backends refuse such a path before
  they write.
- **A template takes the first case that holds.** The function compares
  the blob hashes at the tip with the hashes of the source.
  1. The template exists, and the hashes are equal. The backend writes nothing.
  2. The template exists, and the hashes differ. The backend commits the
     source on the tip and moves the default branch to that commit. The
     move compares the old commit.
  3. The template does not exist. The backend creates it from the source
     and publishes it.
- **A shared repository is seeded once.**
  [Shared repositories](#shared-repositories) states the case.
- **Each write ends with a read.** The function reads the repository
  again. It fails with the name of the repository when the repository is
  missing. It fails for a template that does not hold its source.
- **A refused update can still succeed.** The update step throws with the
  cause when the backend refuses the move. The function then reads the
  tip. When the tip holds the source, another host process landed the same
  files, and the registration succeeds. Otherwise it throws the error of
  the step. Two host processes that register one template at once then
  agree.

**Each case writes the description of the registration.** A changed
description replaces the old one, and the tree can stay the same.

**`justGitBackend` builds the template in `just-git` storage.** For case 2,
the backend makes `template-sources/<template>` hold the source tree at
its tip, and it moves the default branch of `templates/<template>` to that
commit. For case 3, it makes `template-sources/<template>` hold the source
tree, and it creates the repository when it is absent. It commits the
source when the tip differs. It then forks that repository to
`templates/<template>`, read-only, and waits until the fork can be cloned.

**An update is a fast-forward.** The new commit has the old tip as its
parent, so a clone of the template can pull it. The commit goes to
`template-sources/<template>`, because a fork in `just-git` reads its
objects from the root of its fork tree. A fork of the template made after
the update then reads the new objects.

**An update does not change a fork.** A fork holds its own refs from the
moment it was made. It keeps the commit it came from, and its owner can
merge the new tip of the template.

A crash between the steps of case 2 or case 3 leaves a state that the
same case finishes at the next registration.

**`fromDirectory(path)` reads every file as bytes.** It skips `.git` and
every symbolic link. The root entry `@ambionframework/workspace` exports
it. A plain object maps each path to text.

**A template with forks stays.** A fork can read the objects of its
template. Removal of a registration from the options deletes nothing. The
host deletes a template with its own tools.

## Shared repositories

**Every agent of a workspace can push to `shared/<name>`.** A shared
repository belongs to the workspace, so agents in different rooms use the
same repository. The host registers it alongside templates on either git
backend, using the same `RepositoryRegistration` type:

```ts
shared: {
  notes: {
    description: 'Team facts, decisions, and open questions.',
    source: fromDirectory('./notes-seed'),
  },
},
```

**The source seeds the repository once.** Registration creates its first
commit on `main` as `ambion`. The repository becomes available only after
its seed and protection are complete. A later registration does not read
the source or change any file or ref; it updates the description when it
differs. Removing the registration deletes nothing and revokes no write
access. A failed initial registration can be retried.

**The default branch keeps its history.** A push cannot delete it or move
it to a commit that does not descend from its current tip. Protection
applies only to shared repositories. Other branches can be created,
rewritten, and deleted; an agent's fork keeps its own push rules. Any
agent can commit unwanted content, including a deletion of every file:
protection preserves history, not the content of the current tree.

**Use a `git clone` to work together and `fork` to work separately.** A clone of
`shared/notes` pushes back to the shared repository. A fork goes to the
calling agent's namespace. Fetch and rebase before pushing; after a
rejected push, fetch again, resolve conflicts, and retry. Git rejects
competing updates of one tip; resolving a conflict still requires the
agents' judgment.

## The tools

**The git backend adds two tools: `repos` and `fork`.** Each tool does one
thing, the same as `read`, `bash`, and `sql`. A single tool with an
`action` field has parameters that apply to one action only, and a model
can fill them in for the other action. The file is
`packages/workspace/src/git-tools.ts`.

**The audit log records each call.** `openWorkspace` records both
tools, the same as every tool of the bundle. The clone of a `fork` call runs
as one more operation on the bash resource, and the log records one entry
for the `fork` call.

**A push does not name its activation.** `connect` receives no
`ToolContext`. The audit
entry of the `bash` call that ran `git push` holds the activation.

### Clone with bash

**`bash` checks out any repository without a fork.** The agent takes the
clone URL from `repos` and runs `git clone <url> <path>`. The `origin` of the
clone is the source, with the push permissions of the source. A clone of
`shared/<name>` pushes back to it. A clone of a template or of another
agent's fork is read-only. A large repository needs a raised `wait` on the
`bash` call.

### repos

**The result is a Markdown table with one line for each repository.**

- `Description` shows the text that the host registered with a template.
  It is empty for a fork.
- `Branches` shows each branch with the first seven characters of its
  commit. It shows five branches at most, and then the count of the
  others.
- `URL` is the clone URL.

```text
| Repository              | Description                                             | Forked from             | Branches                      | URL                                              |
| ----------------------- | ------------------------------------------------------- | ----------------------- | ----------------------------- | ------------------------------------------------ |
| templates/weekly-report | A weekly status report: numbers, risks, and next steps. |                         | main 5c76d2e                  | http://git.ambion.invalid/templates/weekly-report |
| analyst/report          |                                                         | templates/weekly-report | main 5c76d2e, week-39 e5ec80f | http://git.ambion.invalid/analyst/report          |

2 repositories.
```

**An empty result is one line:** `No repositories on <server>.` The
`details` hold `server` and the count of `repositories`, for logs and UI.

### fork

**The `clone` option resolves the same as a file tool's path.** `~` and a relative
path resolve under the agent's home. The tool runs `env.fork` on the git
resource, and that operation ends. The tool then runs `git clone <url>
<path>` on the bash resource as the calling agent, so the clone sets
`origin` to the fork.

**Each outcome has one text.** `<url>` is the fork's clone URL. A missing
source, a refused fork, and a failed clone fail the call, and the error
text is the text below. After a failed clone, the fork stays.

| Outcome                 | The result text                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forked                  | `Forked templates/weekly-report to analyst/report. Clone URL: <url>`                                                                                                       |
| Forked and cloned       | The line above, then `Cloned it into /home/analyst/report on branch <default branch>. origin is the fork.`                                                                 |
| No such source          | `templates/weekly-report does not exist. Call repos to list the repositories.`                                                                                             |
| Name taken              | `analyst/report exists. Clone URL: <url>.` With `clone`, the tool then clones it, the same as a new fork                                                                   |
| Name taken, path in use | The line above, then `/home/analyst/report already exists, so the tool made no clone.`                                                                                     |
| Refused                 | `The git server refused the fork: <message> Call repos to see what exists.`                                                                                                |
| Clone failed            | The forked line, then `The clone into /home/analyst/report failed: <git output>. The fork stays. Run git clone <url> <path> with bash, at a path that does not exist yet.` |

**A taken name makes a repeated call safe.** A `fork` call that repeats
after a timeout finds its own fork, and the result gives its URL. With
`clone`, the tool clones the fork when the path does not exist yet. The
call creates nothing twice.

**The `details` hold `repository`, `source`, `url`, and `clone` when it is
set.**

**The host can prepare a fork before the first activation.** Host code
calls `lab.git.use(agent, (env) => env.fork('templates/weekly-report',
'report'))`, then clones through `lab.use`. The agent then starts with a
working copy.

## Cite a commit

**A commit ref holds the full hash.** A branch moves at the next push, so
a ref that names a branch alone changes its meaning. The ref keeps the
name that pointed at the commit and the commit itself:

```text
ambion://workspace/<workspace>/repo/<namespace>/<name>/commit/<hash>
ambion://workspace/<workspace>/repo/<namespace>/<name>/branch/<branch>/commit/<hash>
ambion://workspace/<workspace>/repo/<namespace>/<name>/tag/<tag>/commit/<hash>
```

The kernel owns the form ([Definitions and tools](agent.md)). A branch or a
tag name is one percent-encoded part, so `feature/pour` is
`feature%2Fpour`. The hash has 40 hex digits, or 64 in a SHA-256
repository.

**An agent writes the ref, and a host checks it.** The git note states the
form, and an agent takes the full hash from `git rev-parse` in its clone
after it pushes. No tool makes the ref: the form is fixed text, and the
room refuses a ref that is not canonical when the agent says it. Whether
the commit exists on the server is a question for the reader of the ref.

**`workspace.commitRef(repository, at)` gives a host the ref of the commit
on the server.** `at` is `{ branch }`, `{ tag }`, or `{ commit }`, and a
commit hash may be short. A host compares a cited ref with the one this
gives, or cites a commit itself. It throws when the workspace has no git
backend, and when the repository or the name does not exist.

```ts
const ref = await lab.commitRef('analyst/report', { branch: 'week-39' });
await visit.send({ text: 'Week 39 is ready for review.', refs: [ref] });
```

**`workspace.readCommit(ref)` gives the commit that a ref names.** It
gives a `GitCommit`: the message, the author, the parents, and each
changed file. A host shows a cited commit with it, and the Workbench
previews a commit ref with it. It throws when the ref is not a commit ref
of this workspace, and when the repository holds no commit with the hash.
The branch or the tag of the ref plays no part. The commit outlasts a move
or a delete of its branch while the repository keeps it.

```ts
const commit = await lab.readCommit(ref);
console.log(commit.message, commit.changes.length);
```

**`show` reads one commit by its full hash.** `assertCommitHash` in
`@ambionframework/workspace/git` refuses a hash that is not 40 or 64
lowercase hex digits, so no backend reads a short hash or a name. The
message is the text git stores, with its last newline. The changes compare
the commit with its first parent, with no rename detection, and `byPath`
in `@ambionframework/workspace/git` gives their order. A file that becomes
a symbolic link is `modified`. A merge commit lists what it changed against
its first parent. The workstation passes `--diff-merges=first-parent` to
`git diff-tree`, which needs git 2.31 or newer on the server.

**`resolve` reads a name as a name.** `revisionOf(at)` in
`@ambionframework/workspace/git` turns `at` into `refs/heads/<branch>`,
`refs/tags/<tag>`, or the hash, and a backend adds `^{commit}`, so an
annotated tag gives the commit it points at. `revisionOf` refuses a name
that `git check-ref-format` refuses, such as `main~1` or `a..b`, and a hash
that is not 7 to 64 lowercase hex digits.

**A hash names an object alone.** A backend looks a hash up among the
objects, and never among the branches and the tags. An agent can push a
branch named `2076eb9`, and `{ commit: '2076eb9' }` still gives the commit
whose hash starts with those digits. A prefix of more than one object gives
nothing. An annotated tag object gives the commit it points at.

## The guidance

**The workspace gives one guidance text to every agent.** `tools()`
returns one `ToolBundle` for every seat, so the guidance names no agent.
It says `<your name>`. The text enters every activation of every seat that
holds the bundle, so the git note stays short.

**`openWorkspace` joins the notes in this order.**

1. The files note.
2. The process note ([Processes](processes.md#the-guidance)).
3. The snapshot note ([Snapshot a file](snapshots.md#snapshot-a-file)).
4. The SQL note, when the workspace has a SQL backend.
5. The git note.
6. The bash backend's note about its shell.
7. The audit note, when `audit` is set.
8. The rooms note, when `rooms` is set.

The guidance holds no list of the tools. The tool list of the seat names
them.

**The git note states the namespaces and the rule that persists an
edit.** The workspace writes the backend's `label` into the first line, and
its own name into the form of a commit ref.

**The workstation note states that the shell has network access.** The git
note names no credential, so the guidance does not point an agent at a
token.

**The prompt of a seat adds the task alone.** The seat's instructions
need no git commands, no URL, and no rule about pushes.

## Credentials

**A credential of `justGitBackend` grants one scope on one repository,
and it expires.** The backend issues the credentials, and the host gives
the backend its secret. An agent holds this set:

| Repository                 | Scope   |
| -------------------------- | ------- |
| Each fork in its namespace | `write` |
| Each shared repository     | `write` |
| Each template              | `read`  |
| Each fork of another agent | `read`  |

**An agent holds one credential for each repository.** Its own fork gets
the `write` credential alone, which also reads. No agent holds a
credential for `template-sources` of `justGitBackend`.

**Push rights rest on the credential set.** An agent holds write
credentials for its own namespace and `shared`, and read credentials for
templates and other agents' forks. The server checks the credential and
protects the default branch of shared repositories in its pre-receive
hook.

**A credential lives for `credentialTtl`, 1 hour by default.** A client asks
again before it expires. A new fork adds a write credential at once.

**`justGitBackend` signs a new credential at each call.** The just-bash
`git` asks for a credential at each request, so no client keeps one.

### On the just-bash backends

**The just-bash backends read the access of `justGitBackend`.** The access
is a `JustGitAccess` from `@ambionframework/just-bash/git`. The root entry
imports the type alone, so it loads no `node:sqlite`. The option `git` of
`memoryBackend` and `directoryBackend` takes the backend.

**The token stays inside the `git` command.** `gitFor(agent, access)`
builds the `just-git` client with these options:

- `network.allowed` is `[access.prefix]`, so `git` reaches no other host.
- `network.fetch` is `access.fetch`, so each request stays in the
  process.
- `credentials` is `(url) => access.credentialFor(agent, url)`, as a
  bearer token.

**No file, environment variable, or `git config` change reaches the
token.** An agent cannot read it or push with another agent's token. A
`GIT_HTTP_BEARER_TOKEN` that an agent sets gives no credential that the
server accepts.

### On a workstation

**The workstation reads the access of `workstationGitBackend`.** The
access reaches the git account over `ssh`. Each agent holds a key that
names it, and the forced command `serve` of the git account applies the
namespace rule to each request. [Workstation git](workstation-git.md#keys)
states the keys, and [Workstation](workstation.md#a-git-backend) states the
files in the agent's home.

## justGitBackend: a server in the host's process

**`@ambionframework/just-bash/git` implements the backend over
`just-git/server`.**
`just-git` already gives the just-bash shell its `git` command. Its server
has forks that share objects, push hooks, and a ref policy.

**A clone URL is `http://git.ambion.invalid/<namespace>/<name>`.** The
server and the token check resolve a request path with one function: they
decode it, and they drop the service suffix. Both then name one
repository. A `.git` suffix is part of the name, so the clone URL with
`.git` added names no repository.

**The name `git.ambion.invalid` never resolves.** `.invalid` is a
top-level domain that DNS never answers
([RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.4)).
`access.fetch` is `server.asNetwork('http://git.ambion.invalid').fetch`. It
passes each request to the server in the same process, so no DNS lookup
and no socket take part. It passes no identity, so the server's
`auth.http` checks the token of every request.

**A token is signed and stateless.** It holds the agent, the repository,
the scope, and the expiry, as base64url JSON, then a `.`, then the
HMAC-SHA256 of that text under `secret`. The server accepts it as a
bearer token, or as the password of HTTP basic authentication with any
username. The server's `auth.http` checks the signature, the expiry, and
the repository of the path. Its hooks check the repository and the scope.

**A registry table holds what `just-git` storage does not.** `just-git`
storage lists no repositories and holds no description. The backend keeps
one table, `ambion_repositories`, in the same SQLite file: the ID, the
source, the description, and a state, `forking` or `ready`.

**A fork writes its row first.** The backend inserts the row as
`forking`, calls `forkRepo`, then marks the row `ready`. `forkRepo` runs
its own transactions, so one transaction cannot hold both writes.

**A read changes no row.** `list`, `get`, and the credential calls skip a
`forking` row: it is a fork in flight. Before the first operation, the
backend settles each `forking` row that a crash left: `storage.hasRepo`
true marks it `ready`, and false deletes it. A second fork of a target in
flight waits for the first, and it gets `name_taken`.

**A disposed backend opens nothing.** After `dispose`, each call rejects.
The server drains the requests in flight before the storage closes.

**The backend writes nothing to stdout.** `onError` receives a fault of
the server that the client sees as status 500. Absent, the backend
reports nothing.

**A fork shares the objects of its source.** `just-git` copies the refs
and reads each object from the root repository, so a fork costs a few
table rows. A fork of a fork records the root as its storage parent. The
registry records the direct source.

**`sqliteGitStorage(path)` opens the file through `node:sqlite`.** It
wraps `just-git`'s `BetterSqlite3Storage` with a `transaction()` that
`node:sqlite` does not have. The git file stays apart from the SQL
backend's file, so the `sql` tool does not reach it.

## Persistence

**A push is the point where an edit persists.** The git storage holds
every pushed commit. With `justGitBackend` it is one SQLite file on the
host. With `workstationGitBackend` it is the repositories on the disk of
the server. A restart of the host, a new activation, and a new exchange
all find the same branches.

**The working copy persists with the bash backend.** A commit that the
agent has not pushed lives in the clone, in the agent's home.

| State of an edit             | Memory backend   | Directory backend | Workstation                      |
| ---------------------------- | ---------------- | ----------------- | -------------------------------- |
| Pushed                       | Survives restart | Survives restart  | Survives restart, lost with disk |
| Committed, not pushed        | Lost on restart  | Survives restart  | Survives a host restart          |
| Written, not committed       | Lost on restart  | Survives restart  | Survives a host restart          |
| Any state, after `dispose()` | Kept if pushed   | Kept              | Kept                             |

**The guidance tells the agent to push before it finishes.** The memory
backend loses its working copies on a restart, and the git server is the
one place that every backend keeps. A peer reads only what was pushed.

**The git storage is the record of the code.** The journal stays the
record of the room. Neither writes to the other, and a restart of the host
recovers each one on its own.

## Resources and order

**The git backend has its own resource.** The `repos` and
`fork` tools and host code reach it. A `fork` does not wait for a long
`bash` command, and a long clone does not delay another agent's `fork`.

**Neither resource waits on the other.** A git operation holds no bash
operation: the `fork` tool ends its fork operation before it runs the
clone on the bash resource.
A `git push` in `bash` calls the server
directly, and `credentialFor` reads the registry and signs a token.
Neither takes the git resource, and neither changes a row.

**The server orders the pushes to one repository.** Each ref update
compares the old commit and the new one, and a push that lost the race
fails. A push of the commit that a ref already names updates no ref, so a
tool call that repeats after a timeout is safe.

**A clone or a push holds the bash resource.** On the just-bash backends, the
pack work runs in the host's process. While one agent clones a large
template, every other agent's file tools wait.

**Disposal runs in order.** The SQL resource goes first, then the bash
resource, then the git resource
([Dispose of a resource](workspace.md#dispose-of-a-resource)). The bash
resource waits for its active operation, so a push in flight ends before
the git resource disposes the backend. The `dispose` of `justGitBackend`
closes its server.

## Trust

| Attempt                                       | just-bash backends                          | Workstation                                                                                |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Push to another agent's repository            | Refused: no write credential                | Refused by `serve`                                                                         |
| Push to a template                            | Refused: read-only                          | Refused by `serve` and by the hook of the template                                         |
| Push any content to a shared repository       | Allowed                                     | Allowed                                                                                    |
| Delete or rewrite the shared default branch   | Refused by the server hook                  | Refused by the repository hook                                                             |
| Rewrite or delete another shared branch       | Allowed                                     | Allowed                                                                                    |
| Use another agent's credential                | Not possible: no file holds it              | Needs that agent's key file, mode `0600`, or a copy of it                                  |
| Copy its own token into the record            | Not possible: no file holds it              | Possible. A peer on the server can push to that agent's repositories until the key expires |
| Set `GIT_HTTP_BEARER_TOKEN` to another token  | No effect: the client's own credential wins | Not applicable                                                                             |
| Read another agent's repository on the server | Allowed                                     | Allowed through `serve`                                                                    |
| Read or change another agent's working copy   | Possible: no wall between homes             | Refused: one account for each agent                                                        |
| Read or change a repository on the disk       | Not applicable                              | Refused: the git home has mode `0700`                                                      |
| Reach a host outside the prefix               | Refused by the allow-list                   | Not applicable: the shell has network access                                               |
| Use its credential from another machine       | Not applicable                              | Refused by `from`                                                                          |
| Open a shell as the git account               | Not applicable                              | Refused: `restrict` and the forced command                                                 |

**A commit author is not the authenticated pusher.** The just-bash client
stamps new commits with its agent, and its `git` locks the author when it
creates a commit. A pushed commit can already have another author. On the
workstation the author is client text, and `serve` records the pushing
agent in the reflog alone.

## Limits

- **No backend has a retention policy for forks.** A fork stays until the
  host removes it.
- **The workstation backend has its own limits.** [Workstation
  git](workstation-git.md#limits) states the account quota and the protocol
  version.
