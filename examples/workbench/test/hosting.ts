import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@ambionframework/ambion';
import { byAgent, type Script, scripted } from '@ambionframework/ambion/testing';
import { memoryCanvas, openCanvas } from '@ambionframework/canvas';
import { memoryJournals } from '@ambionframework/journal';
import type { PiExecutionOptions } from '@ambionframework/pi';
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { onTestFinished, vi } from 'vitest';
import { workerNames } from '../src/definitions.ts';
import { PIN_KINDS } from '../src/pins.ts';
import { type OpenOptions, openWorkbench, type Workbench } from '../src/workbench.ts';

/**
 * Scripted executions for the Claude and Codex seats. Each runs a script and
 * needs no key and no network. Without a script, a seat stays quiet.
 */
export function scriptedKinds(
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
type Respond = (agent: string, request: number, closing: boolean) => AssistantMessage;

/**
 * A model stream that answers each request of each Pi seat from `respond`. A
 * request whose signal has aborted ends with an abort.
 */
export function respondingStream(respond: Respond): PiExecutionOptions['stream'] {
	const requests = new Map<string, number>();
	return (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		const system = getCurrentSystemPrompt(context.messages);
		const closing = system.includes('The exchange is over.');
		const agent = system.match(/You are '([^']+)'/)?.[1] ?? 'assistant';
		const request = (requests.get(agent) ?? 0) + 1;
		requests.set(agent, request);
		const response = respond(agent, request, closing);
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
	// The seat kinds read `AMBION_EXECUTOR`, and a scripted host runs the default kinds.
	vi.stubEnv('AMBION_EXECUTOR', '');
	onTestFinished(() => void vi.unstubAllEnvs());
	const workbench = await openWorkbench({
		stream: quietStream(),
		executions: scriptedKinds(),
		...options,
		directory: options.directory ?? (await freshDirectory()),
	});
	onTestFinished(() => workbench.close().catch(() => undefined));
	return workbench;
}

/** A canvas over memory, for a test that defines the team and starts no canvas room. */
export function bundleCanvas() {
	return openCanvas({
		name: 'workbench',
		runtime: createRuntime({ storage: memoryJournals(), execution: [] }),
		store: memoryCanvas(),
		breakout: { team: workerNames },
		widgets: { kinds: PIN_KINDS },
	});
}
