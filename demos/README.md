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

| Date       | Report                                                                | Model      | Published                                                                        |
| ---------- | --------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| 2026-08-26 | [The Room, Verbatim](2026-08-26-the-room-verbatim.html)               | sonnet-4-5 | [artifact](https://claude.ai/code/artifact/bb9a4ec2-2f2d-4ee0-8803-182e2bbc5797) |
| 2026-08-28 | [Three Apps, One Site](2026-08-28-three-apps-one-site.html)           | sonnet-5   | [artifact](https://claude.ai/code/artifact/e170799d-5176-491f-a887-9bde86f0ac02) |
| 2026-08-31 | [One Exchange, One Message](2026-08-31-one-exchange-one-message.html) | sonnet-5   | [artifact](https://claude.ai/code/artifact/f73ba11a-3189-4313-9b97-b61d89bd7089) |
| 2026-08-31 | [How Each Person Reads](2026-08-31-how-each-person-reads.html)     | sonnet-5   | [artifact](https://claude.ai/code/artifact/203189de-f717-4e0e-9793-b991947349de) |
| 2026-09-02 | [The Site Drive](2026-09-02-the-site-drive.html)                     | sonnet-5   | [artifact](https://claude.ai/code/artifact/bb026bd2-1ce3-4aeb-b496-68416695bb63) |

## What each run changed

**The Room, Verbatim.** The first live run of the core, before presence
existed. Five agents and one person, every activation shown in full. The person
is a participant here, seated with the agents — which is what the next change
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

**One Exchange, One Message.** The run that the aide was built against. It is
the same suite and the same three people, and each person now brings an aide.
Four questions open four exchanges, and each one closes into one message: 19
agent messages become 4, of 94 words each on average. The report holds the
comparison [`docs/aide.md`](../docs/aide.md) §18 asks for: the same scenario
runs twice, once with the aides and once with none. The last seat activation
reads 8,391 characters, with 14 messages that stand as 3 summaries; the same
record with nothing folded is 11,698, so the fold takes 28% off what that seat
reads. The two arms come out level this time — the room with aides in it says
more — and the report says so. Priya comes back and asks about a range that
left every seat's context, and the products answer her from the folds and
their own APIs.

The exchange the aide reads — a question, and everything the room does until
it goes quiet again — is the room's own exchange, and it now says so: it has a
file, a type, a reader on the session, and both edges on the event stream. The
comparison run brings no aide at all and still reports four exchanges. The aide
is a seat like any other, seated at the narrow end of attention where nothing
said reaches it, and woken by the close of its person's exchange. Attention is
now the mechanism rather than a set of adjectives: `seated(agent, attention)`
names a point on the scale, `passive` and `attentive` are one line each over
it, and one comparison against a message's reach decides who wakes.

Earlier runs of this report found three faults, and the report records what
they changed. A summary used to start after its person's last summary, so a
person who came back drew one message standing for two other people's
exchanges; it now starts at the question that opened the exchange. A fold used
to claim the message under it, which was false where two ranges overlapped; it
now names the person its summary was written for, and this run contains that
case. The summaries also read long, so the runtime now asks an aide for the
answer and for what changed while the room worked, and for nothing else. One
run put an empty message on the record, so `say` refuses one now.

**How Each Person Reads.** The run that settled what an aide holds. An aide was
documented as holding two things: its person's brief, and their preferences. A
question is a message with a seq, and what a person owns is their `identity`,
which every seat's context already carries. Both were names for something the
aide reads, so [`docs/aide.md`](../docs/aide.md) §2 now holds the one fact no
message carries: how its person reads. The three aides in the example stopped
opening with a restatement of who their person is, and their briefs are a third
shorter — 1,410 characters to 960. The summaries came out at 100 words against
95 in the run before, so a third less instruction bought the same message.

Inside the run, the same record rendered twice is the number to trust: the last
seat activation read 4,940 characters with 17 messages standing as 3 summaries,
against 9,003 with nothing folded, so the fold took 45% off what that seat read.

The comparison arm answers the same four questions with the aide removed from
every person. It read 7,275 characters into its last seat against this run's
4,940, so this time the room with aides in it read less for saying more. The run
before this one came out level on that row. One run does not settle that, and
the report says which rows are structural and which move with the model.

**The Site Drive.** The run that the workspace was built against. The same
suite and the same three people, and the three products now share one
workspace: the site drive, a directory holding the method statement for the
pour, the week's forecast, building control's booking rules and the site
diary. Each product is told which document to read before it speaks and
appends one line to the diary when it changes its own state. The pour moved
from Thursday to Friday on two facts that live only on the drive: the plan's
own rain limit against the forecast, and building control's 48-hour notice
against a Wednesday rebar delivery. The products made 15 calls on the drive,
6 reads and 9 diary lines, beside 47 calls into their own APIs, and the
materials tracker moved the concrete order free of charge.

Two runs came before it, and the report records what each one changed. The
first made four drive calls: the task list never opened building control's
rules because its own task note still carried the rule, so the note now
points at the file, and each product's instruction to read before it speaks
is imperative. The second run read every record as a week stale, because the
runtime stamps the real date into every context and the scenario is set on
25 August; the goal now names the site's calendar. One artefact remains: a
`2>/dev/null` created `dev/null` on the drive, because just-bash treats that
path as a plain file. `FOLLOW_WORK.md` holds it.
