/** A deterministic provider stream for the persistent Task acceptance tests and demo. */
import type { CreateRuntimeOptions } from '@ambionframework/ambion';

type StreamFn = NonNullable<CreateRuntimeOptions['stream']>;

import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';

export interface TaskStreamOptions {
	/** Delay the worker response so a human can inspect an open Task. */
	workerDelayMs?: number;
	/** The terminal result the worker publishes after its delay. */
	workerStatus?: 'succeeded' | 'failed';
}

export interface TaskStreamControl {
	readonly stream: StreamFn;
	setWorkerDelay(delayMs: number): void;
	setWorkerStatus(status: 'succeeded' | 'failed'): void;
}

/** Build one provider stream with no network calls or model credentials. */
export function taskStream(options: TaskStreamOptions = {}): TaskStreamControl {
	let workerDelayMs = options.workerDelayMs ?? 15_000;
	let workerStatus = options.workerStatus ?? 'succeeded';
	let taskRequested = false;
	let answeredQuestions = 0;
	const stream: StreamFn = (model, context, streamOptions) => {
		const output = createAssistantMessageEventStream();
		const agent = agentName(model.id, context);
		const response = answer(agent, context, {
			taskRequested,
			answeredQuestions,
			workerStatus,
		});
		if (response.kind === 'task') taskRequested = true;
		if (response.kind === 'say') answeredQuestions = response.questionCount ?? answeredQuestions;
		const delay = agent === 'builder' && response.kind === 'task' ? workerDelayMs : 0;
		finish(output, response.message, delay, streamOptions?.signal);
		return output;
	};
	return {
		stream,
		setWorkerDelay(delayMs) {
			if (!Number.isFinite(delayMs) || delayMs < 0)
				throw new Error('Worker delay must be nonnegative.');
			workerDelayMs = delayMs;
		},
		setWorkerStatus(status) {
			workerStatus = status;
		},
	};
}

interface Answer {
	kind: 'task' | 'say' | 'quiet';
	message: AssistantMessage;
	questionCount?: number;
}

function answer(
	agent: string,
	context: Context,
	state: {
		taskRequested: boolean;
		answeredQuestions: number;
		workerStatus: 'succeeded' | 'failed';
	},
): Answer {
	const inPass = context.messages.some((message) => message.role === 'toolResult');
	if (inPass) return { kind: 'quiet', message: quiet() };
	const text = contextText(context);
	if (agent === 'builder') {
		const task = /Task (task-[a-z0-9-]+) \(open; pinned to this room\)/.exec(text)?.[1];
		if (task === undefined) return { kind: 'quiet', message: quiet() };
		return {
			kind: 'task',
			message: fauxAssistantMessage(
				[
					fauxToolCall('task_update', {
						task,
						status: state.workerStatus,
						text:
							state.workerStatus === 'succeeded'
								? 'The background work is complete.'
								: 'The background work could not complete.',
					}),
				],
				{ stopReason: 'toolUse' },
			),
		};
	}
	const questions = humanQuestions(text);
	const latest = questions.at(-1) ?? '';
	if (
		agent === 'assistant' &&
		state.taskRequested === false &&
		questions.length > 0 &&
		/task|delegate|background/i.test(latest)
	) {
		return {
			kind: 'task',
			message: fauxAssistantMessage(
				[
					fauxToolCall('task', {
						text: 'Complete the requested background work.',
						agents: ['builder'],
					}),
				],
				{ stopReason: 'toolUse' },
			),
		};
	}
	if (agent !== 'assistant' || state.taskRequested === false)
		return { kind: 'quiet', message: quiet() };
	if (
		questions.length <= state.answeredQuestions ||
		!/status|running|background|task/i.test(latest)
	)
		return { kind: 'quiet', message: quiet() };
	return {
		kind: 'say',
		questionCount: questions.length,
		message: fauxAssistantMessage(
			[
				fauxToolCall('say', {
					text: 'The background Task is still running. I can answer while it works.',
				}),
			],
			{ stopReason: 'toolUse' },
		),
	};
}

function finish(
	output: ReturnType<typeof createAssistantMessageEventStream>,
	message: AssistantMessage,
	delay: number,
	signal: AbortSignal | undefined,
): void {
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const end = () => {
		if (done) return;
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		output.push({ type: 'start', partial: message });
		output.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
	};
	const abort = () => {
		if (done) return;
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		const error = fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' });
		output.push({ type: 'error', reason: 'aborted', error });
	};
	if (signal?.aborted) {
		queueMicrotask(abort);
		return;
	}
	signal?.addEventListener('abort', abort, { once: true });
	if (delay === 0) queueMicrotask(end);
	else timer = setTimeout(end, delay);
}

function agentName(model: string, context: Context): string {
	return (
		context.systemPrompt?.match(/You are '([^']+)'/)?.[1] ?? model.slice(model.indexOf('/') + 1)
	);
}

function contextText(context: Context): string {
	return context.messages
		.map((message) =>
			typeof message.content === 'string'
				? message.content
				: message.content.map((part) => ('text' in part ? part.text : '')).join(''),
		)
		.join('\n');
}

function humanQuestions(text: string): string[] {
	return [...text.matchAll(/^\[alice\] (.+)$/gm)].map((match) => match[1] ?? '');
}

function quiet(): AssistantMessage {
	return fauxAssistantMessage('nothing to add', { stopReason: 'stop' });
}
