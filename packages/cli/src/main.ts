#!/usr/bin/env node
/**
 * The `ambion` binary.
 *
 * Importing PACKAGE_NAME is the point: it proves turbo built the runtime first
 * and that the CLI resolved it across the workspace.
 */
import { PACKAGE_NAME } from '@ambionframework/ambion';
import { runDev } from './lib/dev.ts';
import { parseNewArguments } from './lib/new-arguments.ts';
import { createProject, type Template } from './lib/project.ts';
import { cliVersion } from './lib/version.ts';

function help(version: string): string {
	return [
		`ambion ${version}`,
		'',
		'  -v, --version   Print the version',
		'  -h, --help      Print this message',
		'',
		'  new <directory> [--template node|cloudflare]',
		'                  Create an Ambion team project. The default template is node.',
		'  dev [directory] Start the local team room',
		'',
		`Powered by ${PACKAGE_NAME}.`,
	].join('\n');
}

const NEXT_STEPS: Record<Template, readonly string[]> = {
	node: [
		'      pnpm install',
		'      cp .env.example .env',
		'      # set ANTHROPIC_API_KEY in .env',
		'      pnpm exec ambion dev',
	],
	cloudflare: [
		'      pnpm install',
		'      cp .dev.vars.example .dev.vars',
		'      # set ANTHROPIC_API_KEY in .dev.vars',
		'      pnpm exec ambion dev',
	],
};

async function create(args: readonly string[]): Promise<void> {
	const { directory, template } = parseNewArguments(args);
	const target = await createProject(directory, cliVersion(), template);
	console.log([`Created ${target}.`, '', `Next: cd ${target}`, ...NEXT_STEPS[template]].join('\n'));
}

async function main(argv: readonly string[]): Promise<void> {
	const first = argv[0];

	if (first === '-v' || first === '--version') {
		console.log(cliVersion());
		return;
	}
	if (first === 'new') {
		await create(argv.slice(1));
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
