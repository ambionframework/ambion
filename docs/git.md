# The git backend

**No package implements this page yet.** It is the design of a git backend
for a workspace, proposed for 0.2.0. [The plan](../planning/next.md) does
not list it yet. The examples show the proposed API.

**A git backend hosts the repositories of one workspace.** A host puts
read-only templates on it. A person asks an agent to start from a
template. The agent forks the template, clones the fork into its home,
edits the files, commits, and pushes. The push persists the edits across
a restart of the host.

**This page covers the repositories and the access to them.** A deploy
ref that starts a job is a later design, and it builds on this one.

## What the backend gives an agent

| Operation                   | How the agent does it                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Find a template             | The `repos` tool                                                      |
| Fork a template             | The `fork` tool: a fork in the agent's own namespace                  |
| Clone into the home         | `fork` with `clone`, or `git clone <url>/<agent>/<name>` in `bash`    |
| Edit                        | The `read`, `write`, and `edit` tools, or `bash`                      |
| Work on a branch            | Ordinary `git` in `bash`: `switch -c`, `add`, `commit`, `merge`       |
| Persist the edits           | `git push origin <branch>`; the server checks the namespace           |
| Take a change of a template | Add the template as a second remote, then `git fetch` and `git merge` |

## Prompt an agent

**A person names the template and the result, and the agent does the
rest.** [The guidance](#the-guidance) states the URL, the namespaces, and
the rule that a push persists the edits. An instruction needs no git
commands.

> Start a report from the `weekly-report` template. Fill in this week's
> numbers from `~/data/week.csv`, and push it on a branch named `week-39`.

**The agent then makes five calls.**

1. `fork`, with source `templates/weekly-report`, name `report`, and
   clone `~/report`. The tool forks the template to `analyst/report`
   and clones the fork into `~/report`.
2. `bash` with `cd ~/report && git switch -c week-39`.
3. `edit` on `~/report/report.md`, one call or more.
4. `bash` with `cd ~/report && git add -A && git commit -m "Week 39"`.
5. `bash` with `cd ~/report && git push origin week-39`.

**A later activation continues from the fork.** It clones the fork again,
or it uses the working copy that is still in the home
([Persistence](#persistence)). A peer reviews the work with
`git clone <url>/analyst/report`.

## The name and the packages

**`git` is a third backend kind, beside `bash` and `sql`.** The
`WorkspaceBackends` of [Workspace](workspace.md#query-the-shared-database)
gets an optional `git` key. A workspace with no git backend has no `repos`
and no `fork` tool, and its shell keeps the local `git` it has today.

**Hosting is a backend kind of its own.** The repositories live longer
than any one agent's shell, and they have their own storage. One git
backend serves the just-bash backends and the
[workstation](workstation.md) alike.

**The root entry holds the neutral interface.** `GitBackend`,
`GitAccess`, and `GitEnv` import no git library, the same as `SqlBackend`.

```ts
/** What a bash backend needs to reach the git backend as one agent. */
interface GitAccess {
  /** The base URL every agent clones from, such as `http://git.ambion.invalid`. */
  readonly url: string;
  /** The address a real git client reaches. Absent when the backend serves in process only. */
  readonly endpoint?: string;
  /** A web-standard fetch bound to one agent. The server reads the agent from it. */
  fetchFor(agent: WorkspaceAgent): (request: Request) => Promise<Response>;
  /** The credential of one agent, for a real git client. */
  credentialFor(agent: WorkspaceAgent): Promise<{ username: string; token: string }>;
}

interface GitBackend extends ResourceBackend<GitEnv> {
  readonly access: GitAccess;
  readonly guidance?: string;
}

interface GitEnv extends ResourceEnv {
  list(): Promise<readonly GitRepository[]>;
  fork(source: string, name: string): Promise<GitRepository>;
}

interface GitRepository {
  /** `templates/<name>` or `<agent>/<name>`. */
  readonly id: string;
  /** The repository this one was forked from. */
  readonly source?: string;
  /** Each branch and the commit it names. */
  readonly branches: Readonly<Record<string, string>>;
}
```

**A bash backend receives `GitAccess` when it connects.**
`BashBackend.connect` gets a third, optional argument,
`{ git?: GitAccess }`. `openWorkspace` passes it when `backend.git` is
set. The SQL backend reaches the bash backend through `WorkspaceFiles`,
and the bash backend reaches the git backend through `GitAccess`.

**`@ambionframework/git` implements the backend over `just-git/server`.**
`just-git` already gives the just-bash shell its `git` command. Its server
has forks that share objects, push hooks, and a ref policy. The package
adds the namespaces, the templates, the two tools, and the storage over
`node:sqlite`.

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
      templates: { 'weekly-report': fromDirectory('./templates/weekly-report') },
    }),
  },
});
```

**`Workspace.git` is the owner of the git backend, for host code.** It is
the same as `Workspace.sql`.

**The changelog names three export changes.** `WorkspaceBackends` gets
`git`, `BashBackend.connect` gets its third argument, and the new package
adds its own exports.

## Repositories and their names

**A repository ID has two parts: a namespace and a name.** The server
resolves the path of the URL to the ID, so
`http://git.ambion.invalid/analyst/report` names `analyst/report`.

| Namespace    | Holds                                    | Who writes it                 |
| ------------ | ---------------------------------------- | ----------------------------- |
| `templates/` | The templates of the host                | The host agent, `<name>-host` |
| `<agent>/`   | The forks and repositories of that agent | That agent                    |

**Every agent reads every repository.** Agents in one room share their
work, so a peer clones a fork to review it. The host can narrow this with
an `access` callback ([Open decisions](#open-decisions)).

**`templates` is a reserved name.** The backend refuses an agent whose name
is `templates`.

## Templates

**A template is a repository that no agent can change.** The server refuses
every push to `templates/`. The agent sees the refusal as ordinary git
output:

```text
 ! [rejected]        main -> main (templates/weekly-report is a read-only template)
error: failed to push some refs to 'http://git.ambion.invalid/templates/weekly-report'
```

**The host declares each template, and the backend writes it.** The
`templates` option maps a name to a source. `fromDirectory(path)` reads a
directory on the Ambion host, and a plain object maps paths to text. At
open, the backend compares each source with the tip of its template. When
they differ, it commits the source on top as the host agent. A restart
with the same source writes nothing.

**A fork does not follow its template.** A change of a template adds a
commit to the template. An agent takes it with
`git remote add template http://git.ambion.invalid/templates/<name>`,
then `git fetch template` and `git merge template/main`.

**A template with forks stays.** `just-git` refuses to delete a repository
that has forks, because the forks read its objects. How long a template
and its forks stay is the host's decision.

## The tools

**The git backend adds two tools: `repos` and `fork`.** Each tool does one
thing, the same as `read`, `bash`, and `sql`. A single tool with an
`action` field has parameters that apply to one action only, and a model
can fill them in for the other action.

**The model reads each tool's description in its tool list.**

| Tool    | Description                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `repos` | List the repositories on the workspace's git server: the read-only templates and every agent's repositories.                |
| `fork`  | Fork a repository into your own namespace on the git server. Set clone to put a working copy of the fork in your workspace. |

**A refusal is text, and a fault rejects.** A source that does not exist,
a name that is taken, and a clone that fails come back as text that tells
the agent what to do next. A fault of the git storage or of the bash
owner, and an abort by the caller, reject. The `sql` tool follows the same
rule.

**The audit log records each call.** `openWorkspace` binds both tools
through the audit log, the same as `sql`. The clone inside a `fork` call
runs as one more operation on the bash owner, and the log records one
entry for the `fork` call.

### repos

| Parameter   | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `namespace` | Optional. `templates` or the name of an agent. Omit it to list every repository. |

**The result is a Markdown table with one line for each repository.** The
`Branches` column shows each branch with the first seven characters of its
commit. It shows five branches at most, and then the count of the others.

```text
| Repository              | Forked from             | Branches                      |
| ----------------------- | ----------------------- | ----------------------------- |
| templates/weekly-report |                         | main 5c76d2e                  |
| analyst/report          | templates/weekly-report | main 5c76d2e, week-39 e5ec80f |

2 repositories. Clone one with git clone http://git.ambion.invalid/<repository>.
```

**An empty result is one line.** `No repositories on
http://git.ambion.invalid.` The `details` hold `url` and the count of
`repositories`, for logs and UI.

### fork

```ts
const forkSchema = Type.Object({
  source: Type.String({
    description: 'The repository to fork, such as templates/weekly-report.',
  }),
  name: Type.String({
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
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
path resolve under the agent's home. The tool runs `git clone` through the
bash owner as the calling agent, so the clone sets `origin` to the fork.

**Each outcome has one text.** The URL is the backend's `url`.

| Outcome           | The result text                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Forked            | `Forked templates/weekly-report to analyst/report at http://git.ambion.invalid/analyst/report.`                                       |
| Forked and cloned | The line above, then `Cloned it into /home/analyst/report on branch main. origin is the fork.`                                        |
| No such source    | `templates/weekly-report does not exist. Call repos to list the repositories.`                                                        |
| Name taken        | `analyst/report exists. Clone it with git clone http://git.ambion.invalid/analyst/report, or pick another name.`                      |
| Clone failed      | The forked line, then `The clone into /home/analyst/report failed: <git output>. The fork stays. Clone it with git clone <fork URL>.` |

**A refused name makes a repeated call safe.** A `fork` call that repeats
after a timeout finds its own fork, and the result names it. The call
creates nothing twice.

**The `details` hold `repository`, `source`, `url`, and `clone` when it is
set.**

**A fork shares the objects of its source.** `just-git` copies the refs
and reads each object from the root repository, so a fork costs a few
rows. A fork of a fork records the root as its source.

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

**The git note states the server, the namespaces, and the rule that
persists an edit.** The backend writes its `url` into the first line.

```text
repos and fork reach the git server of this workspace at http://git.ambion.invalid.
templates/<name> is a read-only template. <agent>/<name> belongs to that agent.
You push only to <your name>/<name>, and you can read every repository.
To start from a template, fork it and set clone. Then use git in bash in the clone:
make a branch, commit, and push to origin. git already reaches the server as you.
An edit persists only after you commit it and push it. Push before you finish.
```

**The just-bash note changes one sentence.** Today it says: `A remote is
a path in this filesystem, such as /home/<other agent>/<repo>; git has no
network access.` With a git backend the second half is false. A bash
backend's guidance is one string, set before any agent connects, so the
sentence changes to a form that holds in both cases: `A remote is a path
in this filesystem, or a URL that this guidance names. git reaches no
other host.` With no git backend, the guidance names no URL.

**The workstation note stays.** It already states that the shell has
network access. The git note does not name the credential file, so the
guidance does not point an agent at its token.

**The prompt of a seat adds the task alone.** The seat's instructions
need no git commands, no URL, and no rule about pushes. The guidance
holds them for every seat.

## How the URL works

**The host name in `http://git.ambion.invalid` is a name only.** No DNS
lookup and no socket take part on the just-bash backends. `.invalid` is
a top-level domain that never resolves
([RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.4)), so the
name cannot reach a real host by accident. The just-bash `git` already
gives each commit an `@ambion.invalid` address for the same reason.

**The `just-git` client sends every HTTP request through its network
policy.** The policy has two fields: `allowed`, a list of hosts or URL
prefixes, and `fetch`, a web-standard fetch function.

1. The client checks the URL against `allowed`. A URL outside the list
   fails with
   `fatal: network policy: access to '<url>' is not allowed`.
2. The client calls `fetch` with a web `Request`, the same as it would
   call `globalThis.fetch`.
3. The backend's `fetch` passes the `Request` to the `just-git` server in
   the same process.
4. The server resolves the path of the URL to a repository ID, runs its
   hooks, and returns a web `Response`.

**The just-bash backends build the policy from `GitAccess`.** Today
`gitFor(agent)` sets `network: false`. With a git backend it sets
`allowed` to `[access.url]` and `fetch` to `access.fetchFor(agent)`. The
allow-list holds one URL, so `git` reaches no other host, and `curl` stays
absent. A remote that is a path on the workspace's filesystem keeps
working.

**A workstation runs a real `git`, which resolves the name with DNS.** The
workstation backend writes one line of git configuration for each account
on the first connection:

```sh
git config --global url."<endpoint>/".insteadOf "http://git.ambion.invalid/"
```

The agent uses one URL on every backend, and a script from a template
works on both. The host serves the endpoint
([On a workstation](#on-a-workstation)).

## Credentials

**The host owns the secret, and the backend derives each token from it.**
A token is the HMAC-SHA256 of the agent's name under `secret`. The backend
checks a token by computing it again, so it stores no credential. A new
secret revokes every token at once.

### On the just-bash backends

**No token exists.** `fetchFor(agent)` passes the agent to the server
together with each request, through `server.asNetwork(url, { agent })`.
The server reads the agent from the call, and no header carries it.

**An agent cannot push as another agent.** The identity lives in the
`git` command that the backend built for that agent. No file, environment
variable, or `git config` change reaches it. A `GIT_HTTP_BEARER_TOKEN` that
an agent sets changes nothing.

### On a workstation

**The host serves the git backend over HTTP.** `gitBackend` returns a Node
request handler. The host listens on an address that the server reaches,
and sets `endpoint` to it. A host with no inbound route to the Ambion host
can forward a port on the server's loopback over the SSH client of each
agent (`ssh2` `forwardIn`).

**The workstation backend writes each agent's token into its home on the
first connection.** It writes `~/.git-credentials` with mode `0600` and
sets `credential.helper store`. The home has mode `0700`, so no other
account reads the token. The agent can read its own token.

## Persistence

**A push is the point where an edit persists.** The git storage holds
every pushed commit in one SQLite file. A restart of the host, a new
activation, and a new exchange all find the same branches on the server.

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
one place that every backend keeps. A person can also ask a peer to clone
the branch, and the peer reads only what was pushed.

**`sqliteGitStorage(path)` keeps every repository in one SQLite file.** It
opens the file through `node:sqlite`, the same as `sqliteBackend`. It wraps
`just-git`'s `BetterSqlite3Storage` with a `transaction()` that
`node:sqlite` does not have. A native adapter can go upstream to
`just-git` later. With `':memory:'`, the storage lives as long as the
process, for tests.

**The git file stays apart from the SQL backend's file.** The `sql` tool
does not reach the tables of the git storage.

**The git storage is the record of the code.** The journal stays the
record of the room. Neither writes to the other, and a restart of the host
recovers each one on its own. A message can name a branch and a commit in
its text, so a reader finds the work the message describes.

## Owners and order

**The git backend has its own resource owner.** The `fork` tool and host
code reach it. A `fork` does not wait for a long `bash` command.

**A git operation may wait on the bash owner, and a bash operation never
waits on the git owner.** `fork` with `clone` runs its clone on the bash
owner. A `git push` in `bash` calls the server directly. The server orders
the pushes to one repository: each ref update compares the old commit and
the new one, and a push that lost the race fails.

**A repeated push changes nothing.** A push of the commit that a ref
already names updates no ref. A tool call that repeats after a timeout is
safe.

**A clone or a push holds the bash owner.** On the just-bash backends, the
pack work runs in the host's process. While one agent clones a large
template, every other agent's file tools wait. The backlog item
[A backend profile and concurrent operations](../planning/backlog.md#designs-with-a-shape)
removes this wait.

**Disposal runs in order.** The SQL owner goes first, then the git owner,
then the bash owner, and last the server closes. The server waits for the
pushes in flight.

## Provenance

**Every commit names its agent.** The just-bash `git` locks the author to
the agent's name, and a workstation account commits as itself. The server
checks each push against the agent that sent it.

**A push does not name its activation.** `connect` receives the agent and
a signal, and no `ToolContext`. The audit log entry of the `bash` call
holds the activation, the exchange, and the command. The backlog item
[Tool execution provenance beyond the activation](../planning/backlog.md#designs-with-a-shape)
decides whether `connect` receives the context.

## Trust

**`docs/trust.md` gets a row for the git backend.** The server enforces the
namespace rule on every backend. The bash backend decides the rest.

| Attempt                                       | just-bash backends              | Workstation                            |
| --------------------------------------------- | ------------------------------- | -------------------------------------- |
| Push to another agent's repository            | Refused by the server           | Refused by the server                  |
| Push to a template                            | Refused by the server           | Refused by the server                  |
| Push as another agent                         | Not possible: no token exists   | Needs that agent's token, mode `0600`  |
| Read another agent's repository on the server | Allowed by default              | Allowed by default                     |
| Read another agent's working copy             | Possible: no wall between homes | Refused by the account permissions     |
| Reach a host other than the git backend       | Refused by the allow-list       | Possible: the shell has network access |
| Copy its own token into the record            | Not possible: no token exists   | Possible; rotate `secret` to revoke it |

## Tests

**`gitConformance(harness)` holds the cases of a `GitBackend`.** It lives
in `@ambionframework/workspace/conformance`, beside `sqlConformance`.

- `repos` shows each template, and each fork with its source.
- `fork` with `clone` gives a working copy whose `origin` is the fork.
- A second `fork` with the same name is refused and creates nothing.
- The owner pushes a new branch, and a second clone reads it.
- A push to a template and to another agent's namespace is refused, and
  the agent's `git push` output names the reason.
- A peer clones another agent's fork.

**Unit tests hold the texts.** Each outcome of `fork` and the `repos` table
has a case. One case checks the tool line and the order of the notes, with
and without a SQL backend. One case checks the just-bash note with and
without a git backend.

**The scripted tier runs in process.** It runs the cases on the memory
and the directory backends, with no network. A restart case pushes a
branch, disposes the workspace, opens a new one over the same git file,
and clones the branch with its commits.

**A room test drives the prompt above.** A scripted execution makes the
five calls of [Prompt an agent](#prompt-an-agent). The test then reads the
pushed branch through `lab.git.use`. It needs no model.

**The workstation tier runs a real `git` against the HTTP endpoint.** It
joins the OpenSSH job of [Workstation](workstation.md#tests). It proves
the `insteadOf` line, the credential file and its mode, and that one
account cannot push as another.

## Out of v1

- A deploy ref that starts a job, and the result of the job. A later page
  designs them over this backend.
- A git backend under workerd. `just-git` has a Durable Object storage,
  and the Cloudflare adapter has no workspace yet.
- Import of a template from an external remote, and a mirror of a
  repository to an external host.
- The SSH transport to the git server.
- Garbage collection, and retention of forks.

## Open decisions

- **Access.** Every agent reads every repository by default. An `access`
  callback, `(agent, repository) => 'none' | 'read' | 'write'`, could
  replace the namespace rule.
- **The token.** A token derived from one secret needs no store. A
  resolver for each agent, as the workstation has, lets the host use its
  own secrets manager.
- **The plan.** The item for 0.2.0 in [next.md](../planning/next.md), and
  its place in the lanes.
