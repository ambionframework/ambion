#!/usr/bin/env node
/**
 * The `ambion` binary.
 *
 * Importing PACKAGE_NAME is the point: it proves turbo built the runtime first
 * and that the CLI resolved it across the workspace.
 */
import { PACKAGE_NAME } from '@ambionframework/ambion';
import { runDev } from './lib/dev.ts';
import { createProject, ProjectError } from './lib/project.ts';
import { cliVersion } from './lib/version.ts';

function help(version: string): string {
	return [
		`ambion ${version}`,
		'',
		'  -v, --version   Print the version',
		'  -h, --help      Print this message',
		'',
		'  new <directory> Create an Ambion team project',
		'  dev [directory] Start the local team room',
		'',
		`Powered by ${PACKAGE_NAME}.`,
	].join('\n');
}

async function main(argv: readonly string[]): Promise<void> {
	const first = argv[0];

	if (first === '-v' || first === '--version') {
		console.log(cliVersion());
		return;
	}
	if (first === 'new') {
		if (argv[1] === undefined || argv[2] !== undefined)
			throw new ProjectError('Usage: ambion new <directory>.');
		const target = await createProject(argv[1], cliVersion());
		console.log(
			[
				`Created ${target}.`,
				'',
				`Next: cd ${target}`,
				'      pnpm install',
				'      cp .dev.vars.example .dev.vars',
				'      # set ANTHROPIC_API_KEY in .dev.vars',
				'      pnpm exec ambion dev',
			].join('\n'),
		);
		return;
	}
	if (first === 'dev') {
		await runDev(argv.slice(1));
		return;
	}
	if (first !== undefined && first !== '-h' && first !== '--help') {
		throw new Error(`Unknown command \`${first}\`.`);
	}

	console.log(help(cliVersion()));
}

main(process.argv.slice(2)).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`\nambion: ${message}`);
	process.exitCode = 1;
});
