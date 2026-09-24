# The git backend

**No package implements this page yet.** This page is the design of a git
backend for a workspace. [The plan](../planning/next.md) holds the work as
item S2, in phase 3. The examples show the proposed API.

**A git backend hosts the repositories of one workspace.** A host
registers read-only templates on it. A person asks an agent to start from
a template. The agent forks the template, clones the fork into its home,
edits the files, commits, and pushes. The push persists the edits across a
restart of the host.

**Two implementations meet one contract.** `gitBackend` runs a
[`just-git`](https://github.com/blindmansion/just-git) server in the host's
process. `artifactsBackend` uses
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/). Each
one serves the just-bash backends and the [workstation](workstation.md).
`gitConformance` holds both to the same behavior.

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

/** One credential: one scope on one repository, until `expiresAt`. */
interface GitCredential {
  /** The clone URL of the repository. */
  readonly url: string;
  readonly scope: 'read' | 'write';
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** What a bash backend needs to reach the git backend as one agent. */
interface GitAccess {
  /** Every clone URL starts with this prefix. The just-bash `git` reaches it alone. */
  readonly prefix: string;
  /** Carries a git request in process. Absent, the bash backend uses the network. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The credential of `agent` for one clone URL, or `undefined` for a URL outside the prefix. */
  credentialFor(agent: WorkspaceAgent, url: string): Promise<GitCredential | undefined>;
  /** Every credential that `agent` holds now, for a client that reads them from a file. */
  credentialsFor(agent: WorkspaceAgent): Promise<readonly GitCredential[]>;
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
exist, a name that is taken, and a name that the provider refuses are
`ok: false` outcomes. A fault of the storage or of the provider, and an
abort, reject. `SqlEnv.run` follows the same rule.

**A `name_taken` outcome also waits until the fork can be cloned.** A
`fork` call that repeats after a timeout finds the fork of the first call.
It resolves when that fork can be cloned, the same as a new fork.

**The backend registers its templates before its first operation.**
`openWorkspace` is synchronous, and a backend has no open step. The first
`connect` of the git owner, and the first call of `credentialFor` or
`credentialsFor`, await one registration. A failed registration rejects
that operation with an error that names the template. The next operation
tries again. Host code that wants the error at start calls
`lab.git.use(lab.host, (env) => env.list())`.

**A bash backend receives `GitAccess` when it connects.**
`BashBackend.connect` gets a third, optional argument, `BashServices`,
which holds `git?: GitAccess`. `openWorkspace` wraps the bash backend's
`connect` and passes it when `backend.git` is set.

**`Workspace.git` is the owner of the git backend, for host code.** It is
the same as `Workspace.sql`.

**The changelog names these export changes.**

- `WorkspaceBackends` gets `git`.
- `BashBackend.connect` gets its third argument, `BashServices`.
- `Workspace` gets `git`.
- The root entry exports the types above.
- The conformance entry exports `gitConformance`.
- The new package `@ambionframework/git` exports `gitBackend`,
  `sqliteGitStorage`, and `fromDirectory`, and its entry
  `@ambionframework/git/artifacts` exports `artifactsBackend`.

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
credential grants write on it. `gitBackend` also refuses every push to a
template in its pre-receive hook, and `artifactsBackend` makes each
template a read-only repository.

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
every symbolic link. A plain object maps each path to text.

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

| Outcome           | The result text                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Forked            | `Forked templates/weekly-report to analyst/report. Clone URL: <url>`                                           |
| Forked and cloned | The line above, then `Cloned it into /home/analyst/report on branch <default branch>. origin is the fork.`     |
| No such source    | `templates/weekly-report does not exist. Call repos to list the repositories.`                                 |
| Name taken        | `analyst/report exists. Clone URL: <url>.` With `clone`, the tool then clones it, the same as a new fork       |
| Refused           | `The git server refused the fork: <message>`                                                                   |
| Clone failed      | The forked line, then `The clone into /home/analyst/report failed: <git output>. The fork stays; clone <url>.` |

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

1. The tool line, which counts the tools. With a git backend it names six:
   read, write, edit, bash, repos and fork. With a SQL backend as well, it
   names seven.
2. The SQL note, when the workspace has a SQL backend.
3. The git note.
4. The bash backend's note about its shell.
5. The audit note, when `audit` is set.
6. The rooms note.

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
network access. The git note does not name the credential file, so the
guidance does not point an agent at its tokens.

**The prompt of a seat adds the task alone.** The seat's instructions
need no git commands, no URL, and no rule about pushes.

## Credentials

**A credential grants one scope on one repository, and it expires.** The
backend issues the credentials, and the host gives the backend its secret
or its API token. An agent holds this set:

| Repository                 | Scope   |
| -------------------------- | ------- |
| Each fork in its namespace | `write` |
| Each template              | `read`  |
| Each fork of another agent | `read`  |

**An agent holds one credential for each repository.** Its own fork gets
the `write` credential alone, which also reads. No agent holds a
credential for `template-sources`.

**The one-pusher rule rests on the set.** No agent holds a write
credential for a repository outside its namespace. `gitBackend` also
checks the namespace in its pre-receive hook.

**A credential lives for `tokenTtl`, 1 hour by default.** A client asks
again before it expires. A new fork adds a write credential at once.

**A credential counts as missing when little of its life is left.** The
margin is the smaller of 10 minutes and half of `tokenTtl`. A backend
issues a new credential in place of one inside the margin, so a command
that starts with a credential keeps it for the length of the margin.

### On the just-bash backends

**The token stays inside the `git` command.** `gitFor(agent, access)`
builds the `just-git` client with these options:

- `network.allowed` is `[access.prefix]`, so `git` reaches no other host.
- `network.fetch` is `access.fetch` when it is set. Otherwise the client
  uses the network of the host's process.
- `credentials` is `(url) => access.credentialFor(agent, url)`, as a
  bearer token.

**No file, environment variable, or `git config` change reaches the
token.** An agent cannot read it or push with another agent's token. A
`GIT_HTTP_BEARER_TOKEN` that an agent sets gives no credential that the
server accepts.

### On a workstation

**The real `git` reads the credentials from a file.** On the first
connection of each client, the workstation backend runs:

```sh
git config --global credential.helper store
git config --global credential.useHttpPath true
```

**Each `connect` keeps `~/.git-credentials` current.** It reads
`credentialsFor(agent)` and renders one line for each credential, in this
form:

```text
<protocol>://ambion:<token>@<host>/<path>
```

The username is always `ambion`, and each backend ignores it. The path is
the path of the clone URL, so `credential.useHttpPath` matches one line
to one repository. The backend reads the file over SFTP, and it writes
the file with mode `0600` when the two differ. The home has mode `0700`,
so no other account reads the file.

**`git` can erase a line after a refused request.** The `store` helper
erases a credential that the server refused. The next `connect` writes it
again, and a tool call is one operation, so the next `bash` call has it.

## gitBackend: a server in the host's process

**`@ambionframework/git` implements the backend over `just-git/server`.**
`just-git` already gives the just-bash shell its `git` command. Its server
has forks that share objects, push hooks, and a ref policy.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/just-bash';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    git: gitBackend({
      storage: sqliteGitStorage('./data/lab-git.db'),
      secret: process.env.LAB_GIT_SECRET,
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

| Option      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `storage`   | `sqliteGitStorage(path)`, or `':memory:'` for tests                     |
| `secret`    | The key of every token. A new secret revokes every token                |
| `url`       | The base of every clone URL. The default is `http://git.ambion.invalid` |
| `templates` | The registrations, by template name                                     |
| `tokenTtl`  | Seconds a token lives. The default is 3600                              |

**A clone URL is `<url>/<namespace>/<name>`.** The server resolves the
path of the URL to the ID.

**The name `git.ambion.invalid` never resolves.** `.invalid` is a
top-level domain that DNS never answers
([RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.4)). On the
just-bash backends, `access.fetch` is `server.asNetwork(url).fetch`. It
passes each request to the server in the same process, so no DNS lookup
and no socket take part. It passes no identity, so the server's
`auth.http` checks the token of every request.

**A workstation reaches the git server over HTTP.** `gitBackend` returns
a Node request handler, `handler`. The host listens on an address that
the workstation reaches, and sets `url` to it.

**A token is signed and stateless.** It holds the agent, the repository,
the scope, and the expiry, as base64url JSON, then a `.`, then the
HMAC-SHA256 of that text under `secret`. The server accepts it as a
bearer token, or as the password of HTTP basic authentication with any
username. The
server's `auth.http` checks the signature and the expiry. Its hooks check
the repository and the scope.

**A registry table holds what `just-git` storage does not.** `just-git`
storage lists no repositories and holds no description. The backend keeps
one table, `ambion_repositories`, in the same SQLite file: the ID, the
source, the description, and a state, `forking` or `ready`.

**A fork writes its row first.** The backend inserts the row as
`forking`, calls `forkRepo`, then marks the row `ready`. `forkRepo` runs
its own transactions, so one transaction cannot hold both writes. `list`
and `get` settle a `forking` row that a crash left: `storage.hasRepo`
true marks it `ready`, and false deletes it.

**A fork shares the objects of its source.** `just-git` copies the refs
and reads each object from the root repository, so a fork costs a few
table rows. A fork of a fork records the root as its storage parent. The
registry records the direct source.

**`sqliteGitStorage(path)` opens the file through `node:sqlite`.** It
wraps `just-git`'s `BetterSqlite3Storage` with a `transaction()` that
`node:sqlite` does not have. The git file stays apart from the SQL
backend's file, so the `sql` tool does not reach it.

## artifactsBackend: Cloudflare Artifacts

**`@ambionframework/git/artifacts` implements the backend over the
Artifacts REST API.** It calls the API with `fetch` from the Ambion host.
It needs no Worker. Artifacts is in closed beta, so the details below come
from its documentation, and the conformance suite checks them.

```ts
import { fromDirectory } from '@ambionframework/git';
import { artifactsBackend } from '@ambionframework/git/artifacts';

const git = artifactsBackend({
  accountId: process.env.CF_ACCOUNT_ID,
  apiToken: process.env.CF_ARTIFACTS_API_TOKEN,
  namespace: 'lab',
  templates: {
    'weekly-report': {
      description: 'A weekly status report: numbers, risks, and next steps.',
      source: fromDirectory('./templates/weekly-report'),
    },
  },
});
```

| Option        | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `accountId`   | The Cloudflare account                                                  |
| `apiToken`    | A Cloudflare API token with the Artifacts edit permission               |
| `namespace`   | The Artifacts namespace of this workspace. One workspace, one namespace |
| `templates`   | The registrations, by template name                                     |
| `tokenTtl`    | Seconds a repository token lives, from 60. The default is 3600          |
| `forkTimeout` | Seconds `fork` waits for a fork to become ready. The default is 60      |

**One workspace uses one Artifacts namespace.** The Artifacts fork API
takes no target namespace, so a fork stays in the namespace of its
source. The backend encodes an ID as one Artifacts repository name.

| ID                               | Artifacts repository name        |
| -------------------------------- | -------------------------------- |
| `templates/weekly-report`        | `templates.weekly-report`        |
| `analyst/report`                 | `analyst.report`                 |
| `template-sources/weekly-report` | `template-sources.weekly-report` |

**The encoding reverses at the first `.`.** An agent name holds no `.`,
so the part before the first `.` is the namespace. The backend skips an
Artifacts repository whose name does not decode.

**A clone URL is the Artifacts remote.** The backend takes it from the
`remote` field that the API returns, and it does not build it. It has the
form
`https://<account>.artifacts.cloudflare.net/git/<namespace>/<repository>.git`,
and `access.prefix` is that URL up to `<namespace>/`. `access.fetch` is
absent, so the just-bash `git` uses the network of the host's process.

**Each operation maps to one API call.**

| Contract           | Artifacts                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| `list`             | `GET /repos`, every page, with the description and the default branch       |
| Branches of `list` | The ref advertisement of each repository over smart HTTP, with a read token |
| `fork`             | `POST /repos/<source>/fork`, then wait until the fork's status is `ready`   |
| A template         | `POST /repos` for the source, a push, then a fork with `read_only: true`    |
| `credentialFor`    | `POST /tokens` with `repo`, `scope`, and `ttl`, cached until near expiry    |

**`fork` waits for `ready`.** Artifacts reports a fork as `forking` until
it is ready, and a request to it before then fails with status 409. The
backend reads the status until it is `ready`, the signal aborts, or
`forkTimeout` passes. A timeout is a `refused` outcome that says the fork
is still in progress. A repeated call finds the fork as `name_taken`, and
it waits for `ready` the same way. Registration of a template also waits
for `ready`.

**The backend caches one read token for each repository.** Every agent
reads every repository, so one read token serves them all. The owner's
write token is its own. The cache keeps a token until it enters the
margin of [Credentials](#credentials).

**A token's secret is the part before `?expires=`.** Artifacts returns a
token as `art_v1_<40 hex>?expires=<seconds>`. The credential holds the
secret, and `expiresAt` holds the expiry.

**The backend pushes a template's source with the `just-git` client.** It
builds the commit in memory and pushes it with a write token of
`template-sources.<template>`. It then forks that repository to the
template, with `read_only: true` and the description. An Artifacts repository that is
read-only takes no push, so the template never changes.

**The limits of Artifacts apply.** A repository holds 10 GB at most. The
control plane takes 2,000 requests in 10 seconds for each namespace. A
push goes over protocol v1 alone. The documentation names no SSH
transport.

**One `repos` call costs one request for each repository, and one more.**
`GET /repos` gives the list, and one ref advertisement for each repository
gives its branches.

## Persistence

**A push is the point where an edit persists.** The git storage holds
every pushed commit. With `gitBackend` it is one SQLite file on the host.
With `artifactsBackend` it is off the host. A restart of the host, a new
activation, and a new exchange all find the same branches.

**The working copy persists with the bash backend.** A commit that the
agent has not pushed lives in the clone, in the agent's home.

| State of an edit             | Memory backend   | Directory backend | Workstation      |
| ---------------------------- | ---------------- | ----------------- | ---------------- |
| Pushed                       | Survives restart | Survives restart  | Survives restart |
| Committed, not pushed        | Lost on restart  | Survives restart  | Survives restart |
| Written, not committed       | Lost on restart  | Survives restart  | Survives restart |
| Any state, after `dispose()` | Kept if pushed   | Kept              | Kept             |

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
directly, and `credentialFor` reads a cache and issues a token. Neither
takes the git owner.

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
`dispose` of `gitBackend` closes its server. `artifactsBackend` holds no
connection.

## Trust

**`docs/trust.md` gets a row for the git backend.** The credential set
enforces the one-pusher rule on every backend. The bash backend decides
the rest.

| Attempt                                       | just-bash backends                          | Workstation                               |
| --------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Push to another agent's repository            | Refused: no write credential                | Refused: no write credential              |
| Push to a template                            | Refused: read-only                          | Refused: read-only                        |
| Use another agent's credential                | Not possible: no file holds it              | Needs that agent's file, mode `0600`      |
| Read another agent's repository on the server | Allowed                                     | Allowed                                   |
| Read or change another agent's working copy   | Possible: no wall between homes             | Refused by the account permissions        |
| Reach a host outside the prefix               | Refused by the allow-list                   | Possible: the shell has network access    |
| Copy its own token into the record            | Not possible: no file holds it              | Possible; the token expires in `tokenTtl` |
| Set `GIT_HTTP_BEARER_TOKEN` to another token  | No effect: the client's own credential wins | Not read by the real `git`                |

**Every commit names its agent on the just-bash backends.** The just-bash
`git` locks the author to the agent's name. On a workstation, the agent
can change `user.name`, and the server knows which credential pushed.

## Implementation

**The work lands in five steps, in this order.** Each step passes
`pnpm check` before the next one starts.

**The steps match phase 3 of [the plan](../planning/next.md).** Step 1
waits for phase 2 step 2 there, because both edit the binding of the
workspace's tools.

1. **The contract, in `packages/workspace`.**
   - `git-backend.ts`: the types of [The contract](#the-contract).
   - `backend.ts`: `WorkspaceBackends.git` and `BashServices`.
   - `git-tools.ts`: `repos`, `fork`, and the git note.
   - `default-tools.ts`: the tool line counts the git tools.
   - `workspace.ts`: the git owner, the `connect` wrapper, the tools, the
     order of the notes, `Workspace.git`, and the order of disposal.
   - `conformance.ts`: `gitConformance`.
   - The export snapshot and the changelog.
2. **The just-bash wiring, in `packages/just-bash`.** `gitFor(agent,
access)`, and the one sentence of the guidance.
3. **`gitBackend`, in the new package `packages/git`.** The server, the
   tokens, the reserved names, the registry table, the templates,
   `sqliteGitStorage`, and `fromDirectory`. The scripted tier and the room test run here.
4. **The workstation, in `packages/workstation`.** The two `git config`
   lines and the credential file. The OpenSSH tier runs a real `git`
   against `gitBackend`'s handler.
5. **`artifactsBackend`, in `packages/git/src/artifacts`.** It needs an
   Artifacts account, so its tier runs on request.

## Tests

**`gitConformance(harness)` holds the cases of a `GitBackend`.** It lives
in `@ambionframework/workspace/conformance`, beside `sqlConformance`. The
harness opens a git backend and a bash backend together.

- `repos` shows each template with its description, and each fork with
  its source, its default branch, and its URL.
- `repos` with `namespace` shows that namespace alone.
- `repos` does not show `template-sources`, and no agent holds a
  credential for it.
- `fork` with `clone` gives a working copy whose `origin` is the fork.
  The clone runs at once after `fork` returns.
- A second `fork` with the same name is a `name_taken` outcome, and it
  creates nothing. With `clone`, it clones when the path does not exist.
- A `fork` with a `clone` path that holds files gives the fork and a
  failed clone, and the fork stays.
- A `fork` of a source that does not exist is a `no_source` outcome.
- A fork of a fork names its direct source.
- An abort during `fork` rejects. A repeated call then finds the fork as
  `name_taken`, or makes it.
- An agent named `templates` or `template-sources` is refused.
- The owner pushes a new branch, and a second clone reads it.
- A push to a template is refused, and so is a push to another agent's
  fork. The case checks the exit status of `git push`. The text of a
  refusal differs from one backend to the other.
- A peer clones another agent's fork.
- A registration with the same source writes nothing, and one with a
  changed source rejects the first operation with an error that names
  the template.
- A registration that stopped after the commit to `template-sources`
  ends with the template at the next registration.
- A credential is refused after it expires. The harness opens the
  backend with a `tokenTtl` of 1 second. The case skips a backend whose
  shortest `tokenTtl` is longer than 5 seconds, such as
  `artifactsBackend`.
- A `GIT_HTTP_BEARER_TOKEN` that an agent sets on the just-bash backends
  pushes nothing to another agent's fork.

**Unit tests hold the texts.** Each outcome of `fork` and the `repos` table
has a case. One case checks the tool line and the order of the notes, with
and without a SQL backend. One case checks the just-bash note with and
without a git backend.

**The scripted tier runs `gitBackend` in process.** It runs the cases on
the memory and the directory backends, with no network. A restart case
pushes a branch, disposes the workspace, opens a new one over the same git
file, and clones the branch with its commits.

**A room test drives the prompt above.** A scripted execution makes the
five calls of [Prompt an agent](#prompt-an-agent). The test then reads the
pushed branch through `lab.git.use`. It needs no model.

**The workstation tier runs a real `git` against `gitBackend`.** It joins
the OpenSSH job of [Workstation](workstation.md#tests). It proves the
credential file, its line format, its mode, its refresh after an erase,
and that one account cannot push to another account's fork.

**The Artifacts tier runs on request.** It needs `CF_ACCOUNT_ID` and
`CF_ARTIFACTS_API_TOKEN`, and it skips without them. It runs the cases on
the memory backend and on a workstation. Its first case checks that the
`just-git` client clones from and pushes to Artifacts.

## Out of v1

- A deploy ref that starts a job, and the result of the job. A later page
  designs them over this backend.
- A ref scheme for commits, and a check that a cited commit exists.
- A template that continues the history of an earlier template.
- A git backend inside workerd. `just-git` has a Durable Object storage,
  and Artifacts has a Workers binding. The Cloudflare adapter has no
  workspace yet.
- Import of a template from an external remote, and a mirror of a
  repository to an external host.
- Garbage collection, and retention of forks.
