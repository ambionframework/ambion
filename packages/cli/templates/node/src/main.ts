import { createInterface } from 'node:readline/promises';
import type { Message } from '@ambionframework/ambion';
import { openHost } from './host.ts';

const POLL_MS = 500;

function line(message: Message): string | undefined {
	if (message.kind === 'said') return `${message.from}: ${message.text}`;
	if (message.kind === 'summary') return `${message.from} -> ${message.to}: ${message.text}`;
	return undefined;
}

const host = await openHost({
	directory: '.data',
	onError: (message) => console.error(message),
});
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
	await host.join();
	for (;;) {
		const text = (await terminal.question('> ')).trim();
		if (text === '') break;
		const { from } = await host.send(text);
		let cursor = from;
		// Print each new message until the exchange for this question closes.
		for (;;) {
			const read = await host.read({ since: cursor });
			for (const message of read.messages) {
				const shown = line(message);
				if (shown !== undefined) console.log(shown);
				cursor = message.seq;
			}
			if (read.exchanges.find((exchange) => exchange.from === from)?.status === 'closed') break;
			await new Promise((wake) => setTimeout(wake, POLL_MS));
		}
	}
} finally {
	terminal.close();
	await host.close();
}
