/**
 * Event streams that a real `codex` 0.155.1 produced through the SDK 0.155.1
 * on the model gpt-5.6-luna. Each line of a `.jsonl` file is one raw
 * `ThreadEvent`. `test/fixtures/README.md` says how to record more.
 */
import { readFileSync } from 'node:fs';
import type { ThreadEvent } from '@openai/codex-sdk';

/** The events of one recorded run, in order. */
export function recorded(name: 'plain-answer' | 'shell-command' | 'file-change'): ThreadEvent[] {
	const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as ThreadEvent);
}
