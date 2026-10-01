/**
 * A host in a process of its own. It opens a room with one default Codex
 * seat, sends one line, and waits. The test kills it while the model request
 * is open. No stop and no leave run.
 *
 * Run: `node orphan-host.ts <json>`. The json holds `env`, `home`, `model`,
 * and the options of the seat that the test sets.
 */
import { createRuntime, defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { type CodexOptions, codex, codexExecution } from '../src/index.ts';

const { env, home, model, seat } = JSON.parse(process.argv[2] ?? '{}') as {
	env: Record<string, string>;
	home: string;
	model: string;
	seat: Partial<CodexOptions>;
};

const runtime = createRuntime({
	storage: memoryJournals(),
	execution: codexExecution({ env, home, login: false }),
});
const agent = defineAgent({
	name: 'gpt',
	identity: 'Answers what is asked.',
	executor: codex({ instructions: 'Answer in one sentence.', model, ...seat }),
});
const room = await startRoom({ name: `orphan-${process.pid}`, agents: [agent], runtime });
const visit = await room.visit(defineHuman({ name: 'priya', identity: 'Asks the questions.' }));
await visit.send({ text: 'Is the plan ready?' });
process.stdout.write('sent\n');
// The test kills this process. Nothing else keeps it alive.
await new Promise<void>(() => {
	setInterval(() => {}, 1_000);
});
