#!/usr/bin/env node
/**
 * The `ambion` binary.
 *
 * Importing PACKAGE_NAME is the point: it proves turbo built the runtime first
 * and that the CLI resolved it across the workspace.
 */
import { PACKAGE_NAME } from '@ambionframework/ambion';
import { cliVersion } from './lib/version.ts';

function help(version: string): string {
	return [
		`ambion ${version}`,
		'',
		'  -v, --version   Print the version',
		'  -h, --help      Print this message',
		'',
		`Commands (dev, deploy, init) arrive with ${PACKAGE_NAME}.`,
	].join('\n');
}

function main(argv: readonly string[]): void {
	const first = argv[0];

	if (first === '-v' || first === '--version') {
		console.log(cliVersion());
		return;
	}

	console.log(help(cliVersion()));

	// An absent command must not look like a successful one.
	if (first !== undefined && first !== '-h' && first !== '--help') {
		console.error(`\nUnknown command \`${first}\`.`);
		process.exitCode = 1;
	}
}

main(process.argv.slice(2));
