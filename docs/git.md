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

**`justGitBackend` implements the contract.** It runs a
[`just-git`](https://github.com/blindmansion/just-git) server in the host's
process, and it serves the just-bash backends. The
[workstation](workstation.md) carries the `ssh` transport of
`workstationGitBackend` ([Workstation git](workstation-git.md)).
`gitConformance` holds the contract, so a later implementation meets the
same behavior.

**This page covers the repositories and the access to them.** A deploy
ref that starts a job is a later design, and it builds on this one.

## What the backend gives an agent

| Operation           | How the agent does it                                              |
| ------------------- | ------------------------------------------------------------------ |
| Find a template     | The `repos` tool: each template with its description and clone URL |
| Fork a template     | The `fork` tool: a fork in the agent's own namespace               |
| Clone into the home | `fork` with `clone`, or `git clone <URL from repos>` in `bash`     |
| Edit                | The `read`, `write`, and `edit` tools, or `bash`                   |
| Work on a branch    | Ordinary `git` in `bash`: `switch -c`, `add`, `commit`, `merge`    |
| Persist the edits   | `git push origin <branch>`                                         |
| Review a peer       | `git clone <URL from repos>` of the peer's fork                    |

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

## Decisions taken

- **One agent pushes to a repository: its owner.** A peer reads the
  repository and forks it. Two agents work on one task through two forks.
- **A template never changes.** A change registers a new template under a
  new name. A fork keeps the template it came from.
- **A clone URL is opaque.** The tools give each URL, and no agent builds
  one. Each implementation picks its own URL shape.
- **A credential grants one scope on one repository, and it expires.**
  The owner holds a write credential for each of its repositories. Every
  agent holds a read credential for every other repository.
- **`fork` returns when the fork can be cloned.** An implementation that
  forks in the background waits inside the call.
- **A message names a commit in its text.** The room does not check that
  the commit exists. A ref scheme for commits is later work.
- **A push does not name its activation.** `connect` receives no
  `ToolContext`. The audit log entry of the `bash` call holds the
  activation.

## The contract

**`git` is a third backend kind, beside `bash` and `sql`.** The
`WorkspaceBackends` of [Workspace](workspace.md#query-the-shared-database)
gets an optional `git` key. A workspace with no git backend has no `repos`
and no `fork` tool, and its shell keeps the local `git` it has today.

**The root entry of `@ambionframework/workspace` holds the contract.** It
imports no git library, the same as `SqlBackend`. The file is
`packages/workspace/src/git-backend.ts`, and it holds types only.

```ts
/** A repository ID: `templates/<name>` or `<agent>/<name>`. */
type GitRepositoryId = string;

interface GitRepository {
  readonly id: GitRepositoryId;
  /** The URL a git client clones and pushes. Opaque to the agent. */
  readonly url: string;
  /** The repository this one was forked from. */
  readonly source?: GitRepositoryId;
  /** What the repository holds. The host sets it when it registers a template. */
  readonly description?: string;
  /** The branch that a clone checks out. */
  readonly defaultBranch: string;
  /** Each branch and the full hash of the commit it names. */
  readonly branches: Readonly<Record<string, string>>;
}

/** What a bash backend needs to reach the git backend as one agent. */
interface GitAccess {
  /** The name of the transport, such as `in-process` or `ssh`. */
  readonly transport: string;
}

type GitForkOutcome =
  | { readonly ok: true; readonly repository: GitRepository }
  | { readonly ok: false; readonly reason: 'no_source'; readonly source: GitRepositoryId }
  | { readonly ok: false; readonly reason: 'name_taken'; readonly repository: GitRepository }
  | { readonly ok: false; readonly reason: 'refused'; readonly message: string };

interface GitEnv extends ResourceEnv {
  /** The repositories, in ID order. `namespace` limits the list to one namespace. */
  list(namespace?: string, signal?: AbortSignal): Promise<readonly GitRepository[]>;
  /** One repository, or `undefined` when it does not exist. */
  get(id: GitRepositoryId, signal?: AbortSignal): Promise<GitRepository | undefined>;
  /** Fork `source` to `<agent>/<name>`. Resolves when a clone of the fork succeeds. */
  fork(source: GitRepositoryId, name: string, signal?: AbortSignal): Promise<GitForkOutcome>;
}

interface GitBackend extends ResourceBackend<GitEnv> {
  readonly access: GitAccess;
  /** The server this backend names in the guidance, with no credential. */
  readonly server: string;
}
```

**A refusal is an outcome, and a fault rejects.** A source that does not
exist, a name that is taken, and a name that the server refuses are
`ok: false` outcomes. A fault of the storage or of the server, and an
abort, reject. `SqlEnv.run` follows the same rule.

**A `name_taken` outcome also waits until the fork can be cloned.** A
`fork` call that repeats after a timeout finds the fork of the first call.
It resolves when that fork can be cloned, the same as a new fork.

**The backend registers its templates before its first operation.**
`openWorkspace` is synchronous, and a backend has no open step. The first
`connect` of the git owner, and the first call of `credentialFor`, await
one registration. A failed registration rejects
that operation with an error that names the template. The next operation
tries again. Host code that wants the error at start calls
`lab.git.use(lab.host, (env) => env.list())`.

**A bash backend receives `GitAccess` when it connects.**
`BashBackend.connect` gets a third, optional argument, `BashServices`,
which holds `git?: GitAccess`. `openWorkspace` wraps the bash backend's
`connect` and passes it when `backend.git` is set.

**The core knows a transport by its name alone.** The package of each git
backend extends `GitAccess` with the wire shape of its transport. The
bash backend that carries the transport reads `transport`, and it casts
to the access type of that package.

```ts
interface BashBackend {
  // ...
  /** The git transports that the shell of this backend carries. */
  readonly gitTransports?: readonly string[];
}
```

**`openWorkspace` refuses a pair that does not match.** When
`backend.git` is set and `backend.bash.gitTransports` does not hold its
`transport`, `openWorkspace` throws. Neither backend has a name, so the
error names the `transport` and the `server` of the git backend, and the
transports that the bash backend carries. A bash backend with no
`gitTransports` carries none.

**`Workspace.git` is the owner of the git backend, for host code.** It is
the same as `Workspace.sql`.

**The changelog names these export changes.**

- `WorkspaceBackends` gets `git`.
- `BashBackend.connect` gets its third argument, `BashServices`.
- `Workspace` gets `git`.
- The root entry exports the types above.
- The conformance entry exports `gitConformance`.
- `@ambionframework/just-bash/git` exports `justGitBackend` and
  `sqliteGitStorage`.
- `@ambionframework/workspace/git` exports `fromDirectory`, the other
  template helpers, and the name rules.

## Repositories and their names

**A repository ID has two parts: a namespace and a name.** Agents and the
host use IDs. Each implementation maps an ID to a URL of its own.

| Namespace          | Holds                       | Who can push         |
| ------------------ | --------------------------- | -------------------- |
| `templates`        | The read-only templates     | Nobody               |
| `<agent>`          | The forks of that agent     | That agent           |
| `template-sources` | The source of each template | The backend, in code |

**A name has 1 to 64 characters.** It starts with a lowercase letter or a
digit, and the rest are lowercase letters, digits, `.`, `_`, and `-`. An
agent name matches `^[a-z][a-z0-9-]*$`, so it holds no `.`.

**`templates` and `template-sources` are reserved names.** The backend
refuses an agent with either name, in `connect` and in each credential
call.

**No agent reaches `template-sources`.** `repos` does not list it, and no
agent holds a credential for it. An agent forks a template.

## Templates

**A template is a repository that nobody changes after registration.** No
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

**Registration is idempotent, and it resumes after a crash.** For each
template, the backend builds the git tree of the source in memory with
`just-git`. It then takes the first case that holds.

1. The template exists, and the tree at its tip equals the source tree.
   The backend writes nothing.
2. The template exists, and the trees differ. Registration fails with an
   error that names the template. The host registers the change under a
   new name, such as `weekly-report-2`.
3. The template does not exist. The backend makes
   `template-sources/<template>` hold the source tree at its tip: it
   creates the repository when it is absent, and it commits the source
   when the tip differs. It then forks that repository to
   `templates/<template>`, read-only, and waits until the fork can be
   cloned.

A crash between the steps of case 3 leaves a state that case 3 finishes
at the next registration.

**`fromDirectory(path)` reads every file as bytes.** It skips `.git` and
every symbolic link. `@ambionframework/workspace/git` exports it. A plain
object maps each path to text.

**A template with forks stays.** A fork can read the objects of its
template. Removal of a registration from the options deletes nothing. The
host deletes a template with its own tools.

## The tools

**The git backend adds two tools: `repos` and `fork`.** Each tool does one
thing, the same as `read`, `bash`, and `sql`. A single tool with an
`action` field has parameters that apply to one action only, and a model
can fill them in for the other action. The file is
`packages/workspace/src/git-tools.ts`.

**The model reads each tool's description in its tool list.**

| Tool    | Description                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `repos` | List the repositories on the workspace's git server: the read-only templates and every agent's forks, with clone URLs.      |
| `fork`  | Fork a repository into your own namespace on the git server. Set clone to put a working copy of the fork in your workspace. |

**The audit log records each call.** `openWorkspace` binds both tools
through the audit log, the same as `sql`. The clone of a `fork` call runs
as one more operation on the bash owner, and the log records one entry
for the `fork` call.

### repos

| Parameter   | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `namespace` | Optional. `templates` or the name of an agent. Omit it to list every repository. |

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

```ts
const forkSchema = Type.Object({
  source: Type.String({
    description: 'The repository to fork, such as templates/weekly-report.',
  }),
  name: Type.String({
    pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
    description: 'The name of the fork. The fork is <your name>/<name>.',
  }),
  clone: Type.Optional(
    Type.String({
      description: 'A path for a working copy of the fork, such as ~/report. Omit it to fork only.',
    }),
  ),
});
```

**`clone` resolves the same as a file tool's path.** `~` and a relative
path resolve under the agent's home. The tool runs `env.fork` on the git
owner, and that operation ends. The tool then runs `git clone <url>
<path>` on the bash owner as the calling agent, so the clone sets
`origin` to the fork.

**Each outcome has one text.** `<url>` is the fork's clone URL.

| Outcome                 | The result text                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Forked                  | `Forked templates/weekly-report to analyst/report. Clone URL: <url>`                                           |
| Forked and cloned       | The line above, then `Cloned it into /home/analyst/report on branch <default branch>. origin is the fork.`     |
| No such source          | `templates/weekly-report does not exist. Call repos to list the repositories.`                                 |
| Name taken              | `analyst/report exists. Clone URL: <url>.` With `clone`, the tool then clones it, the same as a new fork       |
| Name taken, path in use | The line above, then `/home/analyst/report already exists, so the tool made no clone.`                         |
| Refused                 | `The git server refused the fork: <message>`                                                                   |
| Clone failed            | The forked line, then `The clone into /home/analyst/report failed: <git output>. The fork stays; clone <url>.` |

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

## The guidance

**The workspace gives one guidance text to every agent.** `tools()`
returns one `ToolBundle` for every seat, so the guidance names no agent.
It says `<your name>`. The text enters every activation of every seat that
holds the bundle, so the git note stays at six lines.

**`openWorkspace` joins the notes in this order.**

1. The tool line, which counts the tools. With a git backend it names
   ten: read, write, edit, bash, ps, status, wait, cancel, repos and fork.
   With a SQL backend as well, it names eleven.
2. The process note ([Processes](processes.md#the-guidance)).
3. The SQL note, when the workspace has a SQL backend.
4. The git note.
5. The bash backend's note about its shell.
6. The audit note, when `audit` is set.
7. The rooms note.

**The git note states the namespaces and the rule that persists an
edit.** The workspace writes the backend's `server` into the first line.

```text
repos and fork reach the git server of this workspace, <server>.
templates/<name> is a read-only template. <agent>/<name> belongs to that agent.
You push only to <your name>/<name>, and you can read every repository.
To start from a template, fork it and set clone. Clone with the URL that repos or
fork gives. In the clone, make a branch, commit, and push to origin with git in bash.
An edit persists only after you commit it and push it. Push before you finish.
```

**The just-bash note changes one sentence.** Today it says: `A remote is
a path in this filesystem, such as /home/<other agent>/<repo>; git has no
network access.` A bash backend's guidance is one string, set before any
agent connects. The sentence changes to a form that holds with and
without a git backend: `A remote is a path in this filesystem, or a URL
that this guidance names. git reaches no other host.`

**The workstation note stays.** It already states that the shell has
network access. The git note names no credential, so the guidance does not
point an agent at a token.

**The prompt of a seat adds the task alone.** The seat's instructions
need no git commands, no URL, and no rule about pushes.

## Credentials

**A credential grants one scope on one repository, and it expires.** The
backend issues the credentials, and the host gives the backend its
secret. An agent holds this set:

| Repository                 | Scope   |
| -------------------------- | ------- |
| Each fork in its namespace | `write` |
| Each template              | `read`  |
| Each fork of another agent | `read`  |

**An agent holds one credential for each repository.** Its own fork gets
the `write` credential alone, which also reads. No agent holds a
credential for `template-sources`.

**The one-pusher rule rests on the set.** No agent holds a write
credential for a repository outside its namespace. `justGitBackend` also
checks the namespace in its pre-receive hook.

**A credential lives for `tokenTtl`, 1 hour by default.** A client asks
again before it expires. A new fork adds a write credential at once.

**`justGitBackend` signs a new credential at each call.** The just-bash
`git` asks for a credential at each request, so no client keeps one.

### On the just-bash backends

**The just-bash backends carry the `in-process` transport.** Their
`gitTransports` is `['in-process']`. They read the access of
`justGitBackend`, a `JustGitAccess` from `@ambionframework/just-bash/git`.
The root entry imports the type alone, so it loads no `node:sqlite`.

```ts
/** One credential: one scope on one repository, until `expiresAt`. */
interface GitCredential {
  /** The clone URL of the repository. */
  readonly url: string;
  readonly scope: 'read' | 'write';
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** A web-standard fetch, in the shape the `just-git` client calls. */
type GitFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface JustGitAccess extends GitAccess {
  readonly transport: 'in-process';
  /** Every clone URL starts with this prefix. The just-bash `git` reaches it alone. */
  readonly prefix: string;
  /** Carries a git request to the server in the same process. */
  readonly fetch: GitFetch;
  /** The credential of `agent` for one clone URL, or `undefined` for a URL that no agent reaches. */
  credentialFor(agent: WorkspaceAgent, url: string): Promise<GitCredential | undefined>;
}
```

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

**The workstation carries the git transport `ssh` of
`workstationGitBackend`.** [Workstation git](workstation-git.md) describes
the backend.

## justGitBackend: a server in the host's process

**`@ambionframework/just-bash/git` implements the backend over
`just-git/server`.**
`just-git` already gives the just-bash shell its `git` command. Its server
has forks that share objects, push hooks, and a ref policy.

```ts
import { directoryBackend } from '@ambionframework/just-bash';
import { justGitBackend, sqliteGitStorage } from '@ambionframework/just-bash/git';
import { openWorkspace } from '@ambionframework/workspace';
import { fromDirectory } from '@ambionframework/workspace/git';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    git: justGitBackend({
      storage: sqliteGitStorage('./data/lab-git.db'),
      secret: process.env.LAB_GIT_SECRET ?? '',
      templates: {
        'weekly-report': {
          description: 'A weekly status report: numbers, risks, and next steps.',
          source: fromDirectory('./templates/weekly-report'),
        },
      },
    }),
  },
});
```

| Option      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `storage`   | `sqliteGitStorage(path)`, or `':memory:'` for tests                    |
| `secret`    | The key of every token. A new secret revokes every token               |
| `templates` | The registrations, by template name                                    |
| `tokenTtl`  | Seconds a token lives. The default is 3600                             |
| `onError`   | Called with a fault of the server. Absent, the backend reports nothing |

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
every pushed commit. With `justGitBackend` it is one SQLite file on the host.
A restart of the host, a new activation, and a new exchange all find the
same branches.

**The working copy persists with the bash backend.** A commit that the
agent has not pushed lives in the clone, in the agent's home.

| State of an edit             | Memory backend   | Directory backend |
| ---------------------------- | ---------------- | ----------------- |
| Pushed                       | Survives restart | Survives restart  |
| Committed, not pushed        | Lost on restart  | Survives restart  |
| Written, not committed       | Lost on restart  | Survives restart  |
| Any state, after `dispose()` | Kept if pushed   | Kept              |

**The guidance tells the agent to push before it finishes.** The memory
backend loses its working copies on a restart, and the git server is the
one place that every backend keeps. A peer reads only what was pushed.

**The git storage is the record of the code.** The journal stays the
record of the room. Neither writes to the other, and a restart of the host
recovers each one on its own.

## Owners and order

**The git backend has its own resource owner.** The `repos` and `fork`
tools and host code reach it. A `fork` does not wait for a long `bash`
command, and a long clone does not delay another agent's `fork`.

**Neither owner waits on the other.** A git operation holds no bash
operation: the `fork` tool ends its git operation before it runs the
clone on the bash owner. A `git push` in `bash` calls the server
directly, and `credentialFor` reads the registry and signs a token.
Neither takes the git owner, and neither changes a row.

**The server orders the pushes to one repository.** Each ref update
compares the old commit and the new one, and a push that lost the race
fails. A push of the commit that a ref already names updates no ref, so a
tool call that repeats after a timeout is safe.

**A clone or a push holds the bash owner.** On the just-bash backends, the
pack work runs in the host's process. While one agent clones a large
template, every other agent's file tools wait. The backlog item
[A backend profile and concurrent operations](../planning/backlog.md#designs-with-a-shape)
removes this wait.

**Disposal runs in order.** The SQL owner goes first, then the bash owner,
then the git owner. The bash owner waits for its active operation, so a
push in flight ends before the git owner disposes the backend. The
`dispose` of `justGitBackend` closes its server.

## Trust

**`docs/trust.md` gets a row for the git backend.** The credential set
enforces the one-pusher rule. The bash backend decides the rest.

| Attempt                                       | just-bash backends                          |
| --------------------------------------------- | ------------------------------------------- |
| Push to another agent's repository            | Refused: no write credential                |
| Push to a template                            | Refused: read-only                          |
| Use another agent's credential                | Not possible: no file holds it              |
| Read another agent's repository on the server | Allowed                                     |
| Read or change another agent's working copy   | Possible: no wall between homes             |
| Reach a host outside the prefix               | Refused by the allow-list                   |
| Copy its own token into the record            | Not possible: no file holds it              |
| Set `GIT_HTTP_BEARER_TOKEN` to another token  | No effect: the client's own credential wins |

**Every commit names its agent.** The just-bash `git` locks the author to
the agent's name.

## Where the code lives

| Package              | File                             | What it holds                                                                               |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/workspace` | `src/git-backend.ts`             | The types of [The contract](#the-contract)                                                  |
| `packages/workspace` | `src/git-tools.ts`               | `repos`, `fork`, and the git note                                                           |
| `packages/workspace` | `src/workspace.ts`               | The git owner, the `connect` wrapper, the check of the transport, and the order of disposal |
| `packages/workspace` | `src/git-conformance.ts`         | `gitConformance`                                                                            |
| `packages/workspace` | `src/git-entry.ts`               | The `/git` entry                                                                            |
| `packages/workspace` | `src/git-names.ts`               | The name rules of a repository ID                                                           |
| `packages/workspace` | `src/git-templates.ts`           | `fromDirectory` and the template helpers                                                    |
| `packages/just-bash` | `src/just-bash.ts`               | `gitFor(agent, access)`                                                                     |
| `packages/just-bash` | `src/git/access.ts`              | `JustGitAccess`, `GitCredential`, and `GitFetch`                                            |
| `packages/just-bash` | `src/git/backend.ts`             | `justGitBackend`, the access, and the environment                                           |
| `packages/just-bash` | `src/git/server.ts`, `tokens.ts` | The `just-git` server, its authentication, and the tokens                                   |
| `packages/just-bash` | `src/git/registration.ts`        | Template registration                                                                       |
| `packages/just-bash` | `src/git/storage.ts`             | `sqliteGitStorage` and the registry table                                                   |

## Tests

**`gitConformance(harness)` holds the cases of a `GitBackend`.** It lives
in `@ambionframework/workspace/conformance`, beside `sqlConformance`. A
harness opens a store: one bash backend, and a factory that opens a git
backend over the same repositories each time it is called. The suite
knows no transport. Four cases ask a hook of the harness for a
credential fact, and each hook takes the backend and the workspace that
the case opened.

- `list` shows each template with its description, and each fork with its
  source, its default branch, and its URL. `list` with a namespace shows
  that namespace alone.
- `list` does not show `template-sources`, and no agent holds a credential
  for it (the hook `sourcesCredential`).
- A clone of a fork has the fork as `origin`.
- A second `fork` with a taken name is `name_taken`, and it creates
  nothing. A `fork` of a missing source is `no_source`.
- A fork of a fork names its direct source.
- An agent named `templates` or `template-sources` is refused, and it gets
  no credential (the hook `issueCredentials`).
- The owner pushes a branch, and a peer reads it.
- A push to a template and a push to another agent's fork are refused,
  and the owner's push is accepted. The case checks the exit status of
  `git push`. The text of a refusal differs from one backend to the
  other.
- An aborted `fork` rejects, and a repeated call is safe.
- Two forks of one name at once give one `ok` and one `name_taken`, and
  forks beside a loop of `issueCredentials` lose no repository. The owner
  then holds a write credential for its fork (the hook
  `writeCredential`).
- A registration with the same source writes nothing, and one with a
  changed source rejects the first operation with an error that names
  the template.
- A credential is refused after it expires (the hook `probeCredential`).
  The harness names its shortest `credentialTtl`, and the case skips a
  backend whose shortest `credentialTtl` is longer than 5 seconds.

**`packages/just-bash` runs the cases on the memory and the directory
backends.** Its own tests add:

- the tokens, and a `tokenTtl` that is not finite;
- an access of another transport at `connect`;
- a registration that stopped after the commit to `template-sources`;
- a restart over one git file;
- a `GIT_HTTP_BEARER_TOKEN` that an agent sets;
- a token on a path that names another repository;
- a backend after `dispose`;
- a template from a directory.

**`packages/workspace` holds the texts and a room test.** Each outcome of
`fork` and the `repos` table has a case, and so do the tool line and the
order of the notes. The room test drives the five calls of
[Prompt an agent](#prompt-an-agent) with a scripted execution, then reads
the pushed branch through `lab.git.use`. No test needs a model.

## Out of v1

- A deploy ref that starts a job, and the result of the job. A later page
  designs them over this backend.
- A ref scheme for commits, and a check that a cited commit exists.
- A template that continues the history of an earlier template.
- A git backend over a hosted service, such as
  [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).
  This is future work.
- A git backend inside workerd. `just-git` has a Durable Object storage,
  and the Cloudflare adapter has no workspace yet.
- Import of a template from an external remote, and a mirror of a
  repository to an external host.
- Garbage collection, and retention of forks.
