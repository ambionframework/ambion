import {
	type AgentDefinition,
	type Attention,
	defineAgent,
	defineTool,
} from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import type { AssistantVariant, FixtureState } from './fixture-state.ts';

export const STOCK = 'The warehouse has 8 units of SKU A available to dispatch today.';
export const R19 =
	'Draft: “R-19 email delivery is unsupported in this static prototype. You can view a reminder preview, but it does not send email.” No files were edited.';
export const INCONCLUSIVE =
	'I could not verify the result. The evidence was inconclusive and no files were changed.';
export const FOLLOW_UP =
	'Mira owns R-19 at /prototype/R-19.html. The approved count is corrected from 10 to 8. I inspected source only, without browser checks or tests. No deployment or release occurred. Email delivery remains unsupported and R-19 is unresolved.';

export function scriptedMessage(call?: ReturnType<typeof fauxToolCall>) {
	const stream = createAssistantMessageEventStream();
	const message = call
		? fauxAssistantMessage([call], { stopReason: 'toolUse' })
		: fauxAssistantMessage('', { stopReason: 'stop' });
	queueMicrotask(() => {
		stream.push({ type: 'start', partial: message });
		stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
	});
	return stream;
}

export function workspaceTools(state: FixtureState, names: readonly ('read' | 'write' | 'edit')[]) {
	return names.map((name) =>
		defineTool({
			name,
			description: `${name} a fixture file.`,
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' }, text: { type: 'string' } },
				required: name === 'read' ? ['path'] : ['path', 'text'],
			},
			execute(params, context) {
				const args = params as { path: string; text?: string };
				if (name !== 'read') state.workspace[args.path] = args.text ?? '';
				const result = state.workspace[args.path] ?? 'File does not exist.';
				const event = {
					order: ++state.order,
					phase: state.phase,
					agent: context.agent.name,
					tool: name,
					path: args.path,
					result,
					mutated: name !== 'read',
				};
				state.peerTools.push(event);
				if (event.mutated) state.effects.push(event);
				return result;
			},
		}),
	);
}

function peer(
	name: string,
	identity: string,
	state: FixtureState,
	tools: readonly ('read' | 'write' | 'edit')[] = [],
): AgentDefinition {
	return defineAgent({
		name,
		identity,
		instructions: 'Contribute the controlled fixture evidence once per exchange.',
		model: `scripted/${name}`,
		tools: workspaceTools(state, tools),
	});
}

export function peersFor(state: FixtureState): AgentDefinition[] {
	const v = state.variant;
	if (v.startsWith('A02') || v.startsWith('A05'))
		return [peer('writer', 'Writes constrained customer drafts.', state, ['write', 'edit'])];
	if (v.startsWith('A03'))
		return [peer('reader', 'Inspects private source evidence.', state, ['read'])];
	if (v === 'A10/dependent')
		return [
			peer('builder', 'Creates artifacts in the fixture workspace.', state, ['write']),
			peer('reviewer', 'Reviews artifacts after the builder records them.', state, ['read']),
		];
	if (v === 'A08/follow-up')
		return [peer('writer', 'Inspects R-19 prototype source and reports status.', state)];
	const inventory = peer('inventory', 'Checks warehouse stock and prepares dispatch plans.', state);
	if (v === 'A06/already-corrected')
		return [inventory, peer('planner', 'Corrects stale dispatch limits from the request.', state)];
	return [
		inventory,
		peer('payroll', 'Maintains payroll and cannot answer warehouse questions.', state),
	];
}

export function seatsFor(variant: AssistantVariant): Readonly<Record<string, Attention>> {
	if (variant === 'A01/named') return { inventory: 'named' };
	if (variant === 'A02/named' || variant === 'A05/named') return { writer: 'named' };
	if (variant === 'A10/dependent') return { builder: 'broadcast', reviewer: 'named' };
	if (variant === 'A06/already-corrected') return { inventory: 'broadcast', planner: 'broadcast' };
	if (variant === 'A08/follow-up') return { writer: 'broadcast' };
	if (
		variant.startsWith('A06') ||
		variant.startsWith('A07') ||
		variant === 'A09/override' ||
		variant === 'A04/broadcast'
	)
		return { inventory: 'broadcast' };
	return {};
}

export function peerCall(state: FixtureState, agent: string) {
	if (state.spoken(agent)) return undefined;
	if (state.variant === 'A08/follow-up' && state.phase > 1) return undefined;
	if (agent === 'reader' && state.variant === 'A03/read' && !state.didTool(agent, 'read'))
		return fauxToolCall('read', { path: '/fixtures/R-19.md' });
	if (agent === 'builder' && !state.didTool(agent, 'write'))
		return fauxToolCall('write', { path: '/fixtures/build.txt', text: 'Built fixture artifact.' });
	if (agent === 'reviewer' && !state.didTool(agent, 'read'))
		return fauxToolCall('read', { path: '/fixtures/build.txt' });
	if (agent === 'payroll') return undefined;
	return fauxToolCall('say', {
		to: agent === 'planner' ? 'inventory' : 'assistant',
		text: peerText(state, agent),
	});
}

function peerText(state: FixtureState, agent: string): string {
	const special: Record<string, string> = {
		reader: INCONCLUSIVE,
		builder: 'Artifact written at /fixtures/build.txt; ready for review.',
		reviewer: `I read /fixtures/build.txt: ${state.workspace['/fixtures/build.txt'] ?? 'missing artifact'}. ${state.workspace['/fixtures/build.txt'] ? 'Review passed.' : 'Review is blocked.'}`,
		planner: 'Correction: 10 is withdrawn. Use the approved limit of 8; do not dispatch.',
		writer: state.variant === 'A08/follow-up' ? FOLLOW_UP : R19,
	};
	if (special[agent]) return special[agent];
	const reports: Partial<Record<AssistantVariant, string>> = {
		'A06/stale': 'I will prepare a 10-unit dispatch plan using the old approved limit of 10.',
		'A06/already-corrected':
			'I will prepare a 10-unit dispatch plan using the old approved limit of 10.',
		'A06/valid': 'I will prepare a plan using the approved limit of 8. Nothing dispatched.',
		'A07/failure': 'The stock service is unavailable. Capacity is unknown; nothing was dispatched.',
		'A07/waiting':
			'Dispatch requires owner authorization. No authorization was recorded; nothing was dispatched.',
	};
	return reports[state.variant] ?? STOCK;
}
