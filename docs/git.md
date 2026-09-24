# The git backend

**No package implements this page yet.** It is the design of a git backend
for a workspace, proposed for 0.2.0. [The plan](../planning/next.md) does
not list it yet. The examples show the proposed API.

**A git backend hosts the repositories of one workspace.** A host puts
read-only templates on it. An agent forks a template, clones the fork into
its home, works on a branch, and pushes. A push to a deploy ref starts a
job that the host runs to completion. The job writes its result back to
the repository, where the agent reads it with `git`.

**The backend needs no wake source.** 0.3.0 item W1 adds a notice that
wakes a seat when a job ends
([After W1](#after-w1)). Until then, an agent reads the result at its next
activation.

## What the backend gives an agent

| Operation                   | How the agent does it                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Start from a template       | The `repo` tool: `fork` a template into its own namespace             |
| Clone into the home         | `git clone http://git.ambion.invalid/<agent>/<name>` in `bash`        |
| Work on a branch            | Ordinary `git` in `bash`: `switch -c`, `add`, `commit`, `merge`       |
| Push                        | `git push origin <branch>`; the server checks the namespace           |
| Deploy                      | `git push origin HEAD:deploy`; a check can refuse it at once          |
| Read the result of a job    | `git fetch origin jobs` and `git show origin/jobs:<sha>/job.json`     |
| Take a change of a template | Add the template as a second remote, then `git fetch` and `git merge` |

## The name and the packages

**`git` is a third backend kind, beside `bash` and `sql`.** The
`WorkspaceBackends` of [Workspace](workspace.md#query-the-shared-database)
gets an optional `git` key. A workspace with no git backend has no `repo`
tool, and its shell keeps the local `git` it has today.

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
```

**A bash backend receives `GitAccess` when it connects.**
`BashBackend.connect` gets a third, optional argument,
`{ git?: GitAccess }`. `openWorkspace` passes it when `backend.git` is
set. The SQL backend reaches the bash backend through `WorkspaceFiles`,
and the bash backend reaches the git backend through `GitAccess`.

**`@ambionframework/git` implements the backend over `just-git/server`.**
`just-git` already gives the just-bash shell its `git` command. Its server
has forks that share objects, push hooks, and a ref policy. The package
adds the namespaces, the templates, the deploy refs, and the jobs branch.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { directoryBackend } from '@ambionframework/just-bash';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';

const git = gitBackend({
  storage: sqliteGitStorage('./data/lab-git.db'),
  secret: process.env.LAB_GIT_SECRET,
  templates: { 'batch-job': fromDirectory('./templates/batch-job') },
  deploy: {
    admit: (push) => checkManifest(push),
    start: (job) => runner.enqueue(job),
  },
});

const lab = openWorkspace({
  name: 'lab',
  backend: { bash: directoryBackend('./data/lab'), git },
});
```

**`Workspace.git` is the owner of the git backend, for host code.** It is
the same as `Workspace.sql`. `git.report` belongs to the backend handle,
because only the host reports on a job.

**The changelog names three export changes.** `WorkspaceBackends` gets
`git`, `BashBackend.connect` gets its third argument, and the new package
adds its own exports.

## Repositories and their names

**A repository ID has two parts: a namespace and a name.** The server
resolves the path of the URL to the ID, so
`http://git.ambion.invalid/alice/report` names `alice/report`.

| Namespace     | Holds                             | Who writes it                  |
| ------------- | --------------------------------- | ------------------------------ |
| `templates/`  | The templates of the host         | The host agent, `<name>-host`  |
| `<agent>/`    | The forks and repositories of one | That agent                     |
| Any namespace | The `jobs` branch                 | The host agent, through report |

**Every agent reads every repository.** Agents in one room share their
work, so a peer clones a fork to review it. The host can narrow this with
an `access` callback ([Open decisions](#open-decisions)).

**`templates` is a reserved name.** The backend refuses an agent whose name
is `templates`.

## Templates

**A template is a repository that no agent can change.** The server refuses
every push to `templates/`. The agent sees the refusal as ordinary git
output:

```
 ! [rejected]        main -> main (templates/batch-job is a read-only template)
error: failed to push some refs to 'http://git.ambion.invalid/templates/batch-job'
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

## Forks and the repo tool

**The git backend adds one tool, `repo`.** It has two actions.

| Action | Parameters                 | What it does                                         |
| ------ | -------------------------- | ---------------------------------------------------- |
| `list` | none                       | The repositories the agent can read, with their tips |
| `fork` | `source`, `name`, `clone?` | Forks `source` to `<agent>/<name>`, and can clone it |

**A fork shares the objects of its source.** `just-git` copies the refs
and reads each object from the root repository, so a fork costs a few
rows. A fork of a fork records the root as its source.

**`clone` puts the fork in the agent's home in the same call.** It names a
path, such as `~/report`. The tool runs `git clone` through `bash` as the
calling agent, so the clone sets `origin` to the fork.

**The host can prepare a fork before the first activation.** Host code
calls `lab.git.use(agent, (env) => env.fork('templates/batch-job', 'job'))`,
then clones through `lab.use`. The agent then starts with a working copy.

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

## Deploy refs and jobs

**A push to the deploy ref of a repository starts a job.** The deploy ref
is `refs/heads/deploy` by default, and the `deploy.ref` option changes it.
An agent deploys with `git push origin HEAD:deploy`. The namespace rule
applies, so an agent deploys only its own repositories.

**A job has one key: `<repository>@<sha>`.** The host's runner uses the
key to find a job that it already started.

### Admission

**`deploy.admit` can refuse a deploy before the ref changes.** It runs in
the server's pre-receive hook. It receives the repository, the agent, the
new commit, and a reader for files at that commit. It returns nothing to
admit, or a message to refuse. The agent reads the message in the output
of its `git push`, in the same activation.

**`admit` runs inside the agent's `bash` call.** On the just-bash backends,
that call holds the bash owner, so every other agent's file tools wait.
Keep `admit` to checks of the tree, such as a manifest that parses. The
command's timeout, 30 seconds by default, also bounds `admit`.

### The handoff

**After the ref changes, the backend records the job, then starts it.**

1. The post-receive hook writes `<sha>/job.json` with state `queued` to
   the repository's `jobs` branch, as the host agent.
2. The backend calls `deploy.start(job)`. The job holds the key, the
   repository, the ref, the commit, and the agent.

**The host reports progress with `report`.** `git.report(key, state)`
writes `<sha>/job.json` again, and an optional `<sha>/log.txt`. The states
are `queued`, `running`, `succeeded`, and `failed`. The last two are final.

**Open recovers every job that a crash left behind.** At open, the backend
reads the deploy ref of each repository.

- A deploy ref whose commit has no entry on `jobs` gets a `queued` entry
  and a `start` call.
- An entry in state `queued` or `running` gets a `start` call again.

**`start` runs at least once for each key.** A crash between the ref
change and the `queued` entry loses nothing: the deploy ref records the
intent, and recovery reads it. Two deploys in quick succession each start
a job. After a crash between them, recovery starts only the commit that
the ref names now.

**A job writes no journal entry.** The room record holds what the agent
says about a deploy. The git backend adds no format change to 0.2.0.

### The jobs branch

**The `jobs` branch holds the result of every job in the repository.**
One folder for each deployed commit, named by its full SHA:

```
<sha>/job.json   { "key", "state", "agent", "started", "ended", "summary" }
<sha>/log.txt    the output the host chose to keep
```

**Only the host writes `jobs`.** The server refuses an agent's push to
it. The host writes through `server.commit`, which runs no hook.

**An agent reads a result with `git`.** Tool guidance names the commands:

```sh
git fetch origin jobs
git show origin/jobs:$(git rev-parse HEAD)/job.json
```

**Read the result once, and do not wait in a loop.** A `sleep` loop in
`bash` holds the bash owner until the command times out, and every other
agent's file tools wait for it. A job that is still `running` ends its
own activation. The agent reads the result at its next activation.

**Nothing wakes the seat when a job ends.** The exchange closes when the
room goes quiet, and the job does not hold it open. The next activation
of the seat reads the result, for example when a person asks how the
deploy went. A host can show the `jobs` branch to people directly.

### After W1

**W1 adds the wake, and the jobs branch stays the record.** A `report` of
a final state delivers one notice with the job key as its stable key. The
notice carries a reference to the job. A repeated `report` lands once.
The reference needs a scheme, such as
`ambion://git/<repository>/job/<sha>`, and W1 decides it.

## Owners and order

**The git backend has its own resource owner.** The `repo` tool and host
code reach it. A `fork` does not wait for a long `bash` command.

**A git operation may wait on the bash owner, and a bash operation never
waits on the git owner.** `fork` with `clone` runs its clone on the bash
owner. A `git push` in `bash` calls the server directly. The server orders
the pushes to one repository: each ref update compares the old commit and
the new one, and a push that lost the race fails.

**A repeated push changes nothing.** A push of the commit that a ref
already names updates no ref and starts no job. A tool call that repeats
after a timeout is safe.

**Disposal runs in order.** The SQL owner goes first, then the git owner,
then the bash owner, and last the server closes. The server waits for the
pushes in flight.

## Storage

**`sqliteGitStorage(path)` keeps every repository in one SQLite file.** It
opens the file through `node:sqlite`, the same as `sqliteBackend`. It wraps
`just-git`'s `BetterSqlite3Storage` with a `transaction()` that
`node:sqlite` does not have. A native adapter can go upstream to
`just-git` later.

**The git file stays apart from the SQL backend's file.** The `sql` tool
does not reach the tables of the git storage.

**The git storage is the record of the code and the jobs.** The journal
stays the record of the room. Neither writes to the other, and a restart
of the host recovers each one on its own.

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
| Push to a template or to `jobs`               | Refused by the server           | Refused by the server                  |
| Push as another agent                         | Not possible: no token exists   | Needs that agent's token, mode `0600`  |
| Read another agent's repository on the server | Allowed by default              | Allowed by default                     |
| Read another agent's working copy             | Possible: no wall between homes | Refused by the account permissions     |
| Reach a host other than the git backend       | Refused by the allow-list       | Possible: the shell has network access |
| Copy its own token into the record            | Not possible: no token exists   | Possible; rotate `secret` to revoke it |

## Tests

**`gitConformance(harness)` holds the cases of a `GitBackend`.** It lives
in `@ambionframework/workspace/conformance`, beside `sqlConformance`.

- A fork lists, clones, and takes a push from its owner.
- A push to a template, to `jobs`, and to another agent's namespace is
  refused.
- A refusal from `admit` reaches the output of `git push`, and the ref
  stays.
- A deploy calls `start` once, and a repeated push calls it no more.
- `report` writes `jobs`, and `git show` reads it back.

**The scripted tier runs in process.** It runs the cases on the memory
and the directory backends, with no network. A restart case stops the
backend between the ref change and the `queued` entry, opens it again,
and finds one `start` call.

**The workstation tier runs a real `git` against the HTTP endpoint.** It
joins the OpenSSH job of [Workstation](workstation.md#tests). It proves
the `insteadOf` line, the credential file and its mode, and that one
account cannot push as another.

**No test needs a model.** A scripted execution drives the room, the same
as every other workspace test.

## Out of v1

- A git backend under workerd. `just-git` has a Durable Object storage,
  and the Cloudflare adapter has no workspace yet.
- Import of a template from an external remote, and a mirror of a
  repository to an external host.
- The SSH transport to the git server.
- Garbage collection and retention of forks and jobs.
- The wake when a job ends. That is 0.3.0 item W1.

## Open decisions

- **Access.** Every agent reads every repository by default. An `access`
  callback, `(agent, repository) => 'none' | 'read' | 'write'`, could
  replace the namespace rule.
- **The job record.** A `jobs` branch is one ref that `git fetch` reads.
  A ref for each job, `refs/jobs/<sha>`, keeps the jobs of two commits
  apart, and costs the agent a longer `fetch` refspec.
- **The token.** A token derived from one secret needs no store. A
  resolver for each agent, as the workstation has, lets the host use its
  own secrets manager.
- **The plan.** The item for 0.2.0 in [next.md](../planning/next.md), and
  its place in the lanes.
