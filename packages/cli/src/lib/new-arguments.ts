import { DEFAULT_TEMPLATE, ProjectError, parseTemplate, type Template } from './project.ts';

const USAGE = 'Usage: ambion new <directory> [--template node|cloudflare].';

export interface NewArguments {
	directory: string;
	template: Template;
}

interface NewParseState {
	directory: string | undefined;
	template: Template;
}

/** Read one argument and return the index of the last argument it used. */
function consumeNewArgument(args: readonly string[], index: number, state: NewParseState): number {
	const arg = args[index] ?? '';
	if (arg === '--template') {
		const value = args[index + 1];
		if (value === undefined) throw new ProjectError(USAGE);
		state.template = parseTemplate(value);
		return index + 1;
	}
	if (arg.startsWith('--template=')) {
		state.template = parseTemplate(arg.slice('--template='.length));
		return index;
	}
	if (arg.startsWith('--') || state.directory !== undefined) throw new ProjectError(USAGE);
	state.directory = arg;
	return index;
}

/** Read the arguments after `ambion new`: one directory and an optional template. */
export function parseNewArguments(args: readonly string[]): NewArguments {
	const state: NewParseState = { directory: undefined, template: DEFAULT_TEMPLATE };
	for (let index = 0; index < args.length; index += 1) {
		index = consumeNewArgument(args, index, state);
	}
	if (state.directory === undefined) throw new ProjectError(USAGE);
	return { directory: state.directory, template: state.template };
}
