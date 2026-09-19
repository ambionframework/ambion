import { parseArgs } from 'node:util';
import { runWorkbench } from './tui.ts';

const USAGE = 'Usage: pnpm start [directory] [--as <person>]';

/** Fail at start when the model has no credential. A room without one never answers. */
function requireCredential(): void {
	const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
	const provider = model.slice(0, model.indexOf('/'));
	const variable = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
	if (process.env[variable]) return;
	throw new Error(
		`No credential for ${model}. Set ${variable} in the environment or in examples/workbench/.env, then run pnpm start again.`,
	);
}

try {
	const { values, positionals } = parseArgs({
		options: { as: { type: 'string' } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new Error(USAGE);
	requireCredential();
	await runWorkbench({
		directory: positionals[0] ?? '.data',
		person: values.as ?? process.env.WORKBENCH_USER,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
