/**
 * A room in a process of its own, for the test that kills it. It runs the
 * chaos scenario over the directory it is given, on the storage it is
 * named, on the system clock, with short leases, and prints one line per
 * append the room's journal takes. The parent kills it at the line it chose,
 * then resumes the name over the same directory.
 *
 *   node --experimental-transform-types child.ts <dir> <name> <delay-ms> <storage>
 */
import { createRuntime, startRoom } from '../../src/index.ts';
import { assistant, colleague, priya, product, questions, sam, slowly, TIMING } from './cast.ts';
import { waitForRoom } from './room.ts';
import { scripted } from './scripted.ts';
import { childStorage, tappedJournals } from './storage.ts';

const [dir, name, delay, storage] = process.argv.slice(2);
if (dir === undefined || name === undefined) {
	throw new Error('usage: child.ts <dir> <name> <ms> <storage>');
}

const journals = tappedJournals(childStorage(storage ?? 'sqlite', dir), (id, n, phase) => {
	if (id === name && phase === 'after') process.stdout.write(`write ${n}\n`);
});
const runtime = createRuntime({
	storage: journals,
	...TIMING,
});
const session = await startRoom({
	name,
	runtime,
	summary: assistant.name,
	seats: { [product.name]: 'broadcast', [colleague.name]: 'broadcast', [assistant.name]: 'none' },
	agents: [product, colleague, assistant],
	streamFn: scripted(slowly(Number(delay ?? 40))),
});

const [first, second, third] = questions;
if (first === undefined || second === undefined || third === undefined) throw new Error('cast');
const hers = await session.visit(priya);
await hers.send({ text: first.text, key: first.key });
await waitForRoom(session);
await hers.leave();
const his = await session.visit(sam);
await his.send({ text: second.text, key: second.key });
await waitForRoom(session);
await his.send({ text: third.text, key: third.key, to: third.to });
await waitForRoom(session);
process.stdout.write('done\n');
// The process ends without a stop: what the journal holds is what a crash leaves.
process.exit(0);
