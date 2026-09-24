import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byAgent, type Script, scripted } from '@ambionframework/ambion/testing';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import { onTestFinished } from 'vitest';
import { type OpenOptions, openWorkbench, type Workbench } from '../src/workbench.ts';

/**
 * Scripted executions for the Claude and Codex seats. Each runs a script and
 * needs no key and no network. Without a script, a seat stays quiet.
 */
export function scriptedFamilies(
	script: Script = byAgent({}),
): NonNullable<OpenOptions['executions']> {
	return { claude: scripted(script), codex: scripted(script) };
}

/** A model stream that gives a quiet reply to each request, and counts the requests. */
export function quietStream(counter = { calls: 0 }): PiExecutionOptions['stream'] {
	return () => {
		counter.calls += 1;
		const output = createAssistantMessageEventStream();
		const response = fauxAssistantMessage('quiet', { stopReason: 'stop' });
		queueMicrotask(() => {
			output.push({ type: 'start', partial: response });
			output.push({ type: 'done', reason: 'stop', message: response });
		});
		return output;
	};
}

/** What a scripted stream answers: the seat, its request count from 1, and whether the exchange closes. */
type Respond = (agent: string, call: number, closing: boolean) => AssistantMessage;

/**
 * A model stream that answers each request of each Pi seat from `respond`. A
 * request whose signal has aborted ends with an abort.
 */
export function scriptedStream(respond: Respond): PiExecutionOptions['stream'] {
	const calls = new Map<string, number>();
	return (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		const closing = context.systemPrompt?.includes('The exchange is over.') ?? false;
		const agent = context.systemPrompt?.match(/You are '([^']+)'/)?.[1] ?? 'assistant';
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
		const response = respond(agent, call, closing);
		queueMicrotask(() => {
			if (options?.signal?.aborted) {
				output.push({
					type: 'error',
					reason: 'aborted',
					error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }),
				});
				return;
			}
			output.push({ type: 'start', partial: response });
			output.push({
				type: 'done',
				reason: response.stopReason as 'stop' | 'toolUse',
				message: response,
			});
		});
		return output;
	};
}

/** A model stream whose replies never end, so an exchange stays open. */
export const idleStream: PiExecutionOptions['stream'] = () => createAssistantMessageEventStream();

/** A fresh directory. The test removes it when it finishes. */
export async function freshDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-'));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/** Open a host on scripted models, in a fresh directory unless the options name one. The test closes it. */
export async function openHost(options: Partial<OpenOptions> = {}): Promise<Workbench> {
	const workbench = await openWorkbench({
		stream: quietStream(),
		executions: scriptedFamilies(),
		...options,
		directory: options.directory ?? (await freshDirectory()),
	});
	onTestFinished(() => workbench.close().catch(() => undefined));
	return workbench;
}
