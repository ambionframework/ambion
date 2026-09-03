# Kestrel Yard, Block C

A construction management suite where each product is an agent: a time
tracker, a task list and a materials tracker. Two specialists are on call in
the reserve, a building control liaison and the plant desk, and the room's
assistant seats one when a question turns on what it alone holds. Three
people share the room — a project manager in the site office, a foreman on
the deck with a phone, and a quantity surveyor at a cost desk. One assistant
writes for all three, each the way they read.

Each product holds its own state and its own API and knows nothing of the
others' internals. It asks them on the record, the way a person does. The
three products share one workspace: the site drive, an in-memory filesystem
holding the documents the site works to.

```sh
cd examples/site
echo 'ANTHROPIC_API_KEY=…' > .env   # git ignores it; both scripts read it
pnpm start                          # open it in your terminal
pnpm demo                           # one scripted run, captured as JSON
```

`AMBION_MODEL` picks the model every product and the assistant run on. It
defaults to `anthropic/claude-sonnet-5`. Each run seeds a fresh in-memory
drive from `drive/`, so the checked-in documents stay as they are between
runs and nothing on disk changes.

## What to look for

**Opening the room wakes one seat, not all of them.** Each seat is seated
at one point of an attention scale — the widest kind of message that wakes it.
The task list is `attentive` (`presence`), so it wakes when somebody arrives
and checks what is blocked on them. The other two sit at the default and do
not: an arrival asks nothing, and three products guessing at what it wants is
three briefings nobody requested. The assistant sits at the narrow end, where
nothing said reaches it at all. Try `/join dan` and watch which seats read
it.

**Waking is not answering.** `· time-tracker read it and stayed idle` is a product
deciding the question was not its own. Those decisions never reach the
record, so the terminal is the only place you see them.

**Presence is context, not a notification.** Nothing infers that somebody
stopped reading: `/leave sam` is what says so, and no clock writes anything.
The next product to speak reads that Sam is absent, when he left, and how much
he has not seen.

**Coming back is a briefing.** `/leave priya`, let the others work, then
`/join priya` and `/missed`. The room marks where each person stopped
reading, so an agent can tell them the one thing that changed rather than
replaying the record.

**The products change the products.** `/api` lists every call they made into
their own data. The task list rewrites due dates and the materials tracker
moves deliveries because the room decided something, not because anyone
typed an edit.

**The products read the drive before they speak, and write the diary when
they act.** Each product is connected to the site drive, so it holds `read`,
`write`, `edit` and `bash` beside its own API. The pour plan says what a
pour needs, the forecast says which day holds, and building control's rules
say when an inspection can happen. A product reads the document its claim
rests on and names the file. When it changes its own state it appends one
line to today's diary with `bash`, and `/diary` shows what the products have
left there. Every product has its own home on the drive, and the diary is
the one file they all write to.

**The assistant seats who the question needs.** `/who` lists two
specialists on call and not in the room. Ask "can I promise Thursday for the
pour?" and watch `· building-control seated by assistant` land before the
products answer: the assistant read the question and the reserve, judged
that the date turns on an inspection slot, and seated the one seat that
holds them. The newcomer wakes on its seating, reads the room as it stands,
and answers beside the products. The assistant seats eagerly: everyone whose
identity touches the question, because a seated specialist with nothing to
add stays quiet for the price of a glance, and one that was never seated
costs the answer. `/seat` and `/unseat` do the same by hand, and both land
on the record.

**The assistant seats who the question needs.** `/who` lists two
specialists on call and not in the room. Ask "can I promise Thursday for the
pour?" and watch `· building-control seated by assistant` land before the
products answer: the assistant read the question and the reserve, judged
that the date turns on an inspection slot, and seated the one seat that
holds them. The newcomer wakes on its seating, reads the room as it stands,
and answers beside the products. The assistant seats eagerly: everyone whose
identity touches the question, because a seated specialist with nothing to
add stays quiet for the price of a glance, and one that was never seated
costs the answer. `/seat` and `/unseat` do the same by hand, and both land
on the record.

**A question opens an exchange.** `— priya asked; the room is working —`
marks it, and `— the exchange is over (3–7) —` marks the moment the seats stop.
That is the exchange, and it is the room's own: it opens the same way whoever
asks, and a client that could re-render would fold the working between those
two lines into a thinking state.

**One question, one message back.** Ask "can I promise Thursday for the
pour?" and watch three products answer it between them. When the exchange closes,
the assistant writes whoever asked the one message they read instead of the
working, marked `∎` and carrying the span it stands for. `/summaries` lists
them. A question the room answers once draws no summary at all: one answer is
left in the voice that gave it.

**One assistant writes for each person their own way.** Ask the same question
as `priya`, then as `sam`, then as `dan`, and compare the three. Priya's opens
with the date, Sam's with what changes for his crews at seven, Dan's with the
money. Nothing in the products knows any of that — how a person reads is the
`preferences` on their definition in `room.ts`, and the assistant reads it at
the one activation where it writes for them.

**A summarised range leaves the products' context.** After a summary lands,
ask a follow-up whose answer was inside the range it stands for. The products
answer from the summary and from their own APIs, because the record is
discussion and the products hold the state.

## The files

| File      | What                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `room.ts` | The products and the specialists on call, their APIs and state; the drive they share; the people; the assistant |
| `main.ts` | The room open in your terminal                                                                                  |
| `demo.ts` | One scripted run, written out as JSON for a report                                                              |
| `drive/`  | The site drive as every run starts: the pour plan, the forecast, the inspection rules, the diary                |

The contracts are [`docs/agent.md`](../../docs/agent.md),
[`docs/presence.md`](../../docs/presence.md),
[`docs/assistant.md`](../../docs/assistant.md),
[`docs/workspace.md`](../../docs/workspace.md) and
[`docs/roster.md`](../../docs/roster.md).
