#!/usr/bin/env node
/**
 * The `ambion` binary.
 *
 * Commands — `dev`, `deploy`, `init` — arrive with the runtime. Until then this
 * reports its version and says so, which is enough to prove the whole chain:
 * turbo builds the runtime first, the CLI resolves it across the workspace,
 * tsdown bundles it, and `bin/ambion.mjs` hands off to the result.
 */
import { PACKAGE_NAME } from '@ambionframework/ambion';
import { cliVersion } from './lib/version.ts';

function help(version: string): string {
	return [
		`ambion ${version}`,
		'',
		'The Ambion command line interface.',
		'',
		'  -v, --version   Print the version',
		'  -h, --help      Print this message',
		'',
		`Commands (dev, deploy, init) land with ${PACKAGE_NAME}; this build has none yet.`,
	].join('\n');
}

function main(argv: readonly string[]): void {
	const first = argv[0];

	if (first === '-v' || first === '--version') {
		console.log(cliVersion());
		return;
	}

	console.log(help(cliVersion()));

	// Anything else is a command that does not exist yet. Say so with a failing
	// exit code rather than pretending the invocation succeeded.
	if (first !== undefined && first !== '-h' && first !== '--help') {
		console.error(`\nUnknown command \`${first}\`.`);
		process.exitCode = 1;
	}
}

main(process.argv.slice(2));
