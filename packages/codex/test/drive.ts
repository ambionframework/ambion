/**
 * One activation of the executor over the real binary, driven without a
 * room. The core state is the real one, over a room that lands every say.
 * A test uses it for what a room cannot time: a cut, a crash, a line that
 * lands as the turn ends, and a resume in a new process.
 */
import type { Step } from '@ambionframework/ambion';
import type {
	ActivationEvent,
	AgentDefinition,
	PassInput,
	VendorSession,
} from '@ambionframework/ambion/hosting';
import { ActivationState } from '../../ambion/src/execution/activation.ts';
import { createCodexOpener } from '../src/executor.ts';
import type { CodexOnScript } from './binary.ts';
import { lands, roomOf, seat, viewOf } from './support.ts';

/** The steps and events of one run, and a way to open its activations. */
export function driven(
	on: CodexOnScript,
	definition: AgentDefinition = seat(),
	options: Partial<Parameters<typeof createCodexOpener>[0]> = {},
) {
	const steps: Step[] = [];
	const events: ActivationEvent[] = [];
	const { room, commits } = roomOf(lands);
	/** The core state of one activation, over its own process. `as` replaces the definition. */
	const activate = (id = 'message:1:gpt:1', as: AgentDefinition = definition) =>
		new ActivationState(
			createCodexOpener({
				definition: as,
				env: on.env,
				home: on.home,
				login: false,
				...(on.codexPath === undefined ? {} : { codexPath: on.codexPath }),
				...options,
			}),
			{
				id,
				room,
				definition: as,
				emit: (event) => void events.push(event),
				trace: { record: (step) => void steps.push(step) },
			},
		);
	return { steps, events, commits, activate };
}

/** The first view of an activation, with the session the room recorded for it to resume. */
export function viewInput(resume?: VendorSession): PassInput {
	const view = viewOf();
	return { kind: 'view', view: resume ? { ...view, spec: { ...view.spec, resume } } : view };
}

/** The delta of a later pass: the view with one more line from the person, at position 2. */
export function deltaInput(): PassInput {
	const view = viewOf();
	const line = {
		kind: 'said' as const,
		seq: 2,
		at: new Date(0).toISOString(),
		from: 'priya',
		text: 'Also name the owner.',
	};
	return {
		kind: 'delta',
		after: 1,
		view: {
			...view,
			through: 2,
			context: { ...view.context, messages: [...view.context.messages, line] },
		},
	};
}
