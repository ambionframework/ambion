/**
 * An actor that plays a person as an agent. It takes the options of an agent
 * definition, and it runs on Pi's `AgentHarness` through `runAgent`. Each
 * move ends with one call to `send` or to `stop`. Before that call, the
 * agent can call its other tools, such as `read` on a file an agent wrote.
 */
import { type AmbionTool, defineTool, type ToolBundle } from '@ambionframework/ambion';
import {
	createExecutionServices,
	type ExecutionServices,
	type RunAgentResult,
	runAgent,
} from '@ambionframework/pi';
import { Type } from 'typebox';
import { actorPrompt, actorSystem } from './render.ts';
import { deadlineSignal } from './signal.ts';
import type { Actor, Move } from './types.ts';

/** The default of `timeoutMs`: real milliseconds for one move. */
export const DEFAULT_MOVE_MS = 60_000;

/** The routing name of every actor request. A scripted stream routes on it. */
export const ACTOR = 'actor';

export interface AgentActorOptions {
	/** A `provider/model-id`. */
	readonly model: string;
	/** The private goal of the person. It has the role of `instructions`. */
	readonly brief: string;
	readonly tools?: readonly AmbionTool[];
	readonly bundles?: readonly ToolBundle[];
	/** The Pi execution services. The default reads `<PROVIDER>_API_KEY`, with sessions in memory. */
	readonly services?: ExecutionServices;
	/** Real milliseconds for one move. The default is 60 000. */
	readonly timeoutMs?: number;
}

const send = defineTool({
	name: 'send',
	description: 'Send your next message to the room. `to` names one participant, when you ask one.',
	parameters: Type.Object({ text: Type.String(), to: Type.Optional(Type.String()) }),
	execute: ({ text }) => {
		if (text.trim() === '') throw new Error('A message needs text.');
		return 'Sent.';
	},
});

const stop = defineTool({
	name: 'stop',
	description: 'Stop: you have the answer, or you give up. Give the reason.',
	parameters: Type.Object({ reason: Type.String() }),
	execute: () => 'Stopped.',
});

/** The move that the call which ended the run stands for. */
function moveOf(result: RunAgentResult): Move {
	const { end, calls, usage } = result;
	const args = end.args as { text?: string; to?: string; reason?: string };
	const extra = { calls: calls.map((call) => ({ tool: call.tool, args: call.args })), usage };
	if (end.tool === 'stop') return { stop: args.reason ?? '', ...extra };
	const text = args.text ?? '';
	return args.to === undefined ? { text, ...extra } : { text, to: args.to, ...extra };
}

/** An actor that plays `brief` on a model, with the tools and bundles of any agent. */
export function agentActor(options: AgentActorOptions): Actor {
	const services = options.services ?? createExecutionServices({ sessions: 'memory' });
	const ms = options.timeoutMs ?? DEFAULT_MOVE_MS;
	return async (seen) => {
		const deadline = deadlineSignal(ms, `The move passed its timeout of ${ms} ms.`);
		try {
			const result = await runAgent(services, {
				model: options.model,
				name: ACTOR,
				agent: { name: seen.person.name, identity: seen.person.identity },
				system: actorSystem(seen.person, options.brief),
				prompt: actorPrompt(seen.exchanges),
				tools: [...(options.tools ?? []), send, stop],
				...(options.bundles === undefined ? {} : { bundles: options.bundles }),
				ends: ['send', 'stop'],
				signal: deadline.signal,
			});
			return moveOf(result);
		} finally {
			deadline.clear();
		}
	};
}
