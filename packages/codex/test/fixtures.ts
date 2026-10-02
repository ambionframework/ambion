/**
 * Notification streams that a real `codex app-server` 0.159.2 produced on a
 * scripted Responses endpoint, for the model gpt-5.6-luna. Each line of a
 * `.jsonl` file is one `{ method, params }` message that the executor reads.
 * `test/fixtures/README.md` says how to record more.
 */
import { readFileSync } from 'node:fs';
import { type Notification, notificationOf } from '../src/protocol.ts';

/** The notifications of one recorded run, in order. */
export function recorded(name: 'plain-answer'): Notification[] {
	const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.flatMap((line) => {
			const { method, params } = JSON.parse(line) as { method: string; params: unknown };
			const note = notificationOf(method, params);
			return note === undefined ? [] : [note];
		});
}
