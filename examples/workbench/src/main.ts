import { parseArgs } from 'node:util';
import { describeUnavailable } from './families.ts';
import { runWorkbench } from './tui.ts';

const USAGE = 'Usage: pnpm start [directory] [--as <person>]';

/**
 * Say which seats cannot run for want of a key. The Workbench still starts and
 * runs the other seats. The terminal shows the same fact beside each seat name.
 */
function reportMissingKeys(): void {
	for (const line of describeUnavailable()) {
		console.error(`${line} Set it in the environment or in examples/workbench/.env.`);
	}
}

try {
	const { values, positionals } = parseArgs({
		options: { as: { type: 'string' } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new Error(USAGE);
	reportMissingKeys();
	await runWorkbench({
		directory: positionals[0] ?? '.data',
		person: values.as ?? process.env.WORKBENCH_USER,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
