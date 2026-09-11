/**
 * A room in a process of its own, for the test that kills it. It runs the
 * chaos scenario over the directory it is given, on the storage it is
 * named, on the system clock, with short leases, and prints one line per
 * append the room's journal takes. The parent kills it at the line it chose,
 * then resumes the name over the same directory.
 *
 *   node --experimental-transform-types child.ts <dir> <name> <delay-ms> <storage>
 */
import { createRuntime, startSession, visitSession } from '../../src/index.ts';
import {
	agents,
	assistant,
	colleague,
	priya,
	product,
	questions,
	sam,
	slowly,
	TIMING,
} from './cast.ts';
import { scripted } from './scripted.ts';
import { childSessions, tappedOpener } from './storage.ts';

const [dir, name, delay, storage] = process.argv.slice(2);
if (dir === undefined || name === undefined) {
	throw new Error('usage: child.ts <dir> <name> <ms> <storage>');
}

const sessions = tappedOpener(childSessions(storage ?? 'jsonl', dir), (id, n, phase) => {
	if (id === name && phase === 'after') process.stdout.write(`write ${n}\n`);
});
const runtime = createRuntime({ sessions, agents, ...TIMING });
const session = startSession({
	name,
	runtime,
	assistant,
	agents: [product, colleague],
	streamFn: scripted(slowly(Number(delay ?? 40))),
});

const [first, second, third] = questions;
if (first === undefined || second === undefined || third === undefined) throw new Error('cast');
const hers = await visitSession(session, priya);
await hers.deliver({ text: first.text, key: first.key });
await session.quiet();
await hers.leave();
const his = await visitSession(session, sam);
await his.deliver({ text: second.text, key: second.key });
await session.quiet();
await his.deliver({ text: third.text, key: third.key, to: third.to });
await session.quiet();
process.stdout.write('done\n');
// The process ends without a stop: what the journal holds is what a crash leaves.
process.exit(0);
