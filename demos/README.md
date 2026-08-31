# Demos

These are dated reports of live runs. One report belongs to one merged
change, and the newest report belongs to the change in flight.

A report captures what the agents did, what it cost, and what the run
established about a design decision. It belongs to the day it ran and to the
code that ran it.

**One branch adds one report.** While a branch is open, regenerate its report
in place as the design moves — those iterations are the branch's history, and
git already holds them. At merge the report becomes the record of that change,
and nobody edits it again to match later code. An old report that describes an
API which no longer exists is doing its job: it shows what the design was
before the change, and why the change happened.

Every report is generated output. A script writes the HTML from the run's
JSON. Nobody edits the numbers by hand.

Name a file `YYYY-MM-DD-<slug>.html`, where the slug names what the run
showed.

## The runs

| Date       | Report                                                      | Model      | Published                                                                        |
| ---------- | ----------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| 2026-08-26 | [The Room, Verbatim](2026-08-26-the-room-verbatim.html)     | sonnet-4-5 | [artifact](https://claude.ai/code/artifact/bb9a4ec2-2f2d-4ee0-8803-182e2bbc5797) |
| 2026-08-28 | [Three Apps, One Site](2026-08-28-three-apps-one-site.html) | sonnet-5   | [artifact](https://claude.ai/code/artifact/e170799d-5176-491f-a887-9bde86f0ac02) |

## What each run changed

**The Room, Verbatim.** The first live run of the core, before presence
existed. Five agents and one person, every turn shown in full. The person is a
participant here, seated with the agents — which is what the next change
undid. It proved the say lock in the open: of the 32 says the agents
attempted, 13 were refused because the record moved while the seat was
drafting. The lock is what keeps a room of agents from all answering the same
question.

**Three Apps, One Site.** The run that presence was built against. A
construction suite where each product is an agent with its own API, and three
people open the same workspace from a site office, a phone and a cost desk.
The report shows the shape the change landed on: a person visits a running
room instead of being seated in it, arriving is a message on the record, a
seat decides for itself whether an arrival wakes it, and the catch-up anchor
is a message on the record rather than a cursor the host kept. Every
activation is in the report in full — the context each seat read, its
reasoning, its API calls and results, and the says the lock refused. The report
also projects where an aide would have engaged, against
[`docs/aide.md`](../docs/aide.md), which that change designed.
