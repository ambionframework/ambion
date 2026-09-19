import { parseArgs } from 'node:util';
import { runWorkbench } from './tui.ts';

const USAGE = 'Usage: pnpm start [directory] [--as <person>]';

try {
	const { values, positionals } = parseArgs({
		options: { as: { type: 'string' } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new Error(USAGE);
	await runWorkbench({
		directory: positionals[0] ?? '.data',
		person: values.as ?? process.env.WORKBENCH_USER,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
