/** Sign in to a subscription provider and keep the credential in a store. */
import type { Interface } from 'node:readline/promises';
import type {
	AuthEvent,
	AuthInteraction,
	Credential,
	CredentialStore,
} from '@earendil-works/pi-ai';

/** The streams of a terminal. Absent, standard input and standard output. */
export interface TerminalStreams {
	readonly input?: NodeJS.ReadableStream;
	readonly output?: NodeJS.WritableStream;
}

/** One line of text for each event that tells the person what to do. */
function describe(event: AuthEvent): string | undefined {
	switch (event.type) {
		case 'info':
			return [event.message, ...(event.links ?? []).map((link) => link.url)].join('\n');
		case 'auth_url':
			return `Open this address and sign in:\n${event.url}${event.instructions ? `\n${event.instructions}` : ''}`;
		case 'device_code':
			return `Open ${event.verificationUri} and enter the code ${event.userCode}.`;
		case 'progress':
			return event.message;
	}
}

/**
 * An interaction that asks on a terminal. A sign-in needs one: the provider
 * sends the person to an address, and the person pastes a code back when the
 * local callback does not arrive. `close` releases the input.
 */
export function terminalInteraction(streams: TerminalStreams = {}): AuthInteraction & {
	close(): void;
} {
	const output = streams.output ?? process.stdout;
	let reader: Promise<Interface> | undefined;
	const lines = () =>
		(reader ??= import('node:readline/promises').then(({ createInterface }) =>
			createInterface({ input: streams.input ?? process.stdin, output }),
		));
	return {
		prompt: async (prompt) => {
			const choices =
				prompt.type === 'select'
					? `\n${prompt.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n`
					: ' ';
			const answer = (await (await lines()).question(`${prompt.message}${choices}`)).trim();
			if (prompt.type !== 'select') return answer;
			return prompt.options[Number(answer) - 1]?.id ?? answer;
		},
		notify: (event) => {
			const text = describe(event);
			if (text !== undefined) output.write(`${text}\n`);
		},
		close: () => void reader?.then((rl) => rl.close()),
	};
}

/**
 * Sign in to `provider` with its OAuth flow, such as `anthropic` for Claude
 * Pro and Max or `openai-codex` for ChatGPT Plus and Pro, and write the
 * credential to `credentials`. Run it once on a host that has a browser,
 * then give `piExecution` the same file. Absent `interaction`, the sign-in
 * asks on the terminal.
 */
export async function loginPi(
	provider: string,
	credentials: CredentialStore,
	interaction?: AuthInteraction,
): Promise<Credential> {
	const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
	const terminal = interaction === undefined ? terminalInteraction() : undefined;
	try {
		return await builtinModels({ credentials }).login(
			provider,
			'oauth',
			interaction ?? (terminal as AuthInteraction),
		);
	} finally {
		terminal?.close();
	}
}
