import {
	type CreateRuntimeOptions,
	createRuntime,
	defaultRuntime,
	defineHuman,
	type Room,
	type Runtime,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import type { ManagedResource } from '@ambionframework/evals';
import { fauxToolCall } from '@earendil-works/pi-ai';
import { defineAssistant } from '../../../src/index.ts';
import {
	peerCall,
	peersFor,
	R19,
	scriptedMessage,
	seatsFor,
	workspaceTools,
} from './fixture-peers.ts';
import { type AssistantVariant, FixtureState, type ProviderCapture } from './fixture-state.ts';
import { fixtureTransport } from './fixture-transport.ts';

export type { AssistantVariant } from './fixture-state.ts';

export type StreamFn = NonNullable<CreateRuntimeOptions['stream']>;
const person = defineHuman({ name: 'priya', identity: 'Owns the request.' });

export interface AssistantEvalFixture {
	readonly state: FixtureState;
	readonly runtime: Runtime;
	readonly room: Room;
	readonly person: typeof person;
	send(text: string): Promise<Awaited<ReturnType<Awaited<ReturnType<Room['visit']>>['send']>>>;
	snapshot(): ReturnType<FixtureState['snapshot']>;
	stop(): Promise<void>;
}
export interface AssistantFixtureOptions {
	model: string;
	variant: AssistantVariant;
	instructions?: string;
	storage?: CreateRuntimeOptions['storage'];
	/** Test only: replace the live subject, while retaining real room and peer execution. */
	subjectStream?: StreamFn;
	manage?: (resource: ManagedResource) => void;
	signal?: AbortSignal;
}

/** Register cleanup before room allocation, including persisted history setup. */
export async function assistantFixture(
	options: AssistantFixtureOptions,
): Promise<AssistantEvalFixture> {
	const state = new FixtureState(options.variant);
	const rooms: Room[] = [];
	const stop = async () => {
		for (const room of rooms.toReversed()) await room.stop();
	};
	options.manage?.({
		abort: async () => {
			for (const room of rooms) await room.abort();
		},
		settle: async () => {
			await Promise.allSettled([...state.pending]);
		},
		dispose: stop,
	});
	try {
		const subject = await subjectStream(options);
		options.signal?.throwIfAborted();
		const runtime = createRuntime({
			storage: options.storage,
			stream: observedStream(options, state, subject),
			transport: fixtureTransport(state),
			retry: { attempts: 1 },
		});
		const assistant = defineAssistant({
			model: options.model,
			instructions: options.instructions,
			tools: options.variant.startsWith('A05') ? workspaceTools(state, ['write', 'edit']) : [],
		});
		const agents = peersFor(state);
		const name = `assistant-eval-${crypto.randomUUID()}`;
		if (options.variant.startsWith('A02'))
			await seedHistory({ name, runtime, assistant, agents, state, rooms });
		options.signal?.throwIfAborted();
		const room = options.variant.startsWith('A02')
			? await resumeRoom(name, { runtime, agents: [assistant, ...agents] })
			: await startRoom({ name, runtime, assistant, agents, seats: seatsFor(options.variant) });
		rooms.push(room);
		const unsubscribe = room.subscribe((event) => {
			if (event.type === 'message') state.accepted(event.message);
			if (event.type === 'error' || event.type === 'audit_error')
				state.diagnostics.push(`${event.type}:${event.agent}:${event.error.message}`);
		});
		options.manage?.({ dispose: unsubscribe });
		return {
			state,
			runtime,
			room,
			person,
			async send(text) {
				state.phase += 1;
				return (await room.visit(person)).send({ text });
			},
			snapshot: () => state.snapshot(),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

async function subjectStream(options: AssistantFixtureOptions): Promise<StreamFn> {
	if (options.subjectStream) return options.subjectStream;
	const resolved = await defaultRuntime.model(options.model, 'assistant');
	return (_requested, context, settings) => defaultRuntime.stream(resolved, context, settings);
}

function observedStream(
	options: AssistantFixtureOptions,
	state: FixtureState,
	subject: StreamFn,
): StreamFn {
	return (requested, context, settings) => {
		if (state.provider.length >= 100)
			throw new Error('The fixture exhausted its 100-request provider budget.');
		const agent =
			requested.id === options.model
				? 'assistant'
				: (requested.id.split('/').at(-1) ?? requested.id);
		const tools = context.tools?.map((tool) => tool.name) ?? [];
		const capture: ProviderCapture = {
			agent,
			phase: state.phase,
			closing: tools.length === 1 && tools[0] === 'say',
			tools,
			system: context.systemPrompt ?? '',
			input: JSON.stringify(context.messages),
			model: requested.id,
		};
		state.provider.push(capture);
		const stream =
			agent === 'assistant'
				? subject(requested, context, settings)
				: scriptedMessage(peerCall(state, agent));
		const pending = Promise.resolve(stream)
			.then((resolved) => resolved.result())
			.then(
				(response) => {
					capture.response = structuredClone(response);
				},
				(error: unknown) => {
					capture.error = String(error);
				},
			);
		state.pending.add(pending);
		void pending.finally(() => state.pending.delete(pending));
		return stream;
	};
}

interface HistoryOptions {
	name: string;
	runtime: Runtime;
	assistant: ReturnType<typeof defineAssistant>;
	agents: ReturnType<typeof peersFor>;
	state: FixtureState;
	rooms: Room[];
}

async function seedHistory({
	name,
	runtime,
	assistant,
	agents,
	state,
	rooms,
}: HistoryOptions): Promise<void> {
	let exchange = 0;
	const seeded = new Set<string>();
	const stream: StreamFn = (model, context) => {
		const isAssistant = model.id === assistant.model;
		const closing = context.tools?.length === 1;
		const key = `${exchange}:${model.id}:${closing}`;
		if (seeded.has(key)) return scriptedMessage();
		seeded.add(key);
		if (isAssistant && closing)
			return scriptedMessage(
				fauxToolCall('say', {
					text:
						exchange === 1
							? R19
							: `Unrelated administrative note ${exchange} recorded. No new draft requested.`,
				}),
			);
		if (isAssistant && exchange === 1)
			return scriptedMessage(
				fauxToolCall('say', {
					to: 'writer',
					text: 'Draft R-19 only in two sentences, with no file edits.',
				}),
			);
		if (!isAssistant && exchange === 1)
			return scriptedMessage(fauxToolCall('say', { to: 'assistant', text: R19 }));
		return scriptedMessage();
	};
	const room = await startRoom({
		name,
		runtime: createRuntime({ storage: runtime.storage, stream, retry: { attempts: 1 } }),
		assistant,
		agents,
		seats: { writer: 'named' },
	});
	rooms.push(room);
	const visit = await room.visit(person);
	for (const text of [
		'Draft R-19 only, in two sentences; do not edit files.',
		'Administrative note: the office opens at nine.',
		'Administrative note: the next meeting is Tuesday.',
	]) {
		exchange += 1;
		await (await visit.send({ text })).waitForSummary();
	}
	if (state.variant === 'A02/reserve') await room.unseat('writer');
	state.history.push(...(await room.read()).messages);
	await room.stop();
}
