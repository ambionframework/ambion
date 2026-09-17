import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import type { AssistantVariant } from './fixture-state.ts';
import type { StreamFn } from './fixtures.ts';

/** A deterministic subject stream that exercises the real room and peer paths. */
export function scriptedSubject(variant: AssistantVariant): StreamFn {
	let ordinaryCalls = 0;
	let providerCalls = 0;
	let dependentHandoffSent = false;
	return (_model, context) => {
		providerCalls += 1;
		if (providerCalls > 30)
			throw new Error(`Deterministic subject exceeded 30 provider calls for ${variant}.`);
		const tools = context.tools?.map((tool) => tool.name) ?? [];
		const closing = tools.length === 1 && tools[0] === 'say';
		const input = JSON.stringify(context.messages);
		const call = closing
			? fauxToolCall('say', { text: summaryFor(variant, input) })
			: ordinaryAction(variant, input, ordinaryCalls++, () => {
					if (dependentHandoffSent) return false;
					dependentHandoffSent = true;
					return true;
				});
		const message = call
			? fauxAssistantMessage([call], { stopReason: 'toolUse' })
			: fauxAssistantMessage('', { stopReason: 'stop' });
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
		});
		return stream;
	};
}

function ordinaryAction(
	variant: AssistantVariant,
	input: string,
	call: number,
	claimDependentHandoff: () => boolean,
) {
	const action = firstAction(variant);
	if (call === 0 && action !== undefined) return action;
	if (
		variant === 'A10/dependent' &&
		input.includes('Artifact written') &&
		claimDependentHandoff()
	) {
		return fauxToolCall('say', {
			to: 'reviewer',
			text: 'Review /fixtures/build.txt after the builder records it.',
		});
	}
	return undefined;
}

function firstAction(variant: AssistantVariant) {
	if (variant === 'A01/named')
		return fauxToolCall('say', { to: 'inventory', text: 'Check current stock for SKU A.' });
	if (variant === 'A02/named' || variant === 'A05/named')
		return fauxToolCall('say', { to: 'writer', text: 'R-19 only, two sentences, no file edits.' });
	if (variant === 'A02/reserve' || variant === 'A05/reserve')
		return fauxToolCall('seat', { name: 'writer' });
	if (variant.startsWith('A03')) return fauxToolCall('seat', { name: 'reader' });
	if (variant === 'A04/reserve') return fauxToolCall('seat', { name: 'inventory' });
	if (variant === 'A06/stale')
		return fauxToolCall('say', {
			to: 'inventory',
			text: 'Correction: use 8 units; the old 10-unit limit is withdrawn.',
		});
	if (variant === 'A08/follow-up') return fauxToolCall('seat', { name: 'writer' });
	if (variant === 'A09/override')
		return fauxToolCall('say', { text: 'Inventory checkpoint recorded.' });
	return undefined;
}

function summaryFor(variant: AssistantVariant, input: string): string {
	if (variant === 'A01/named' || variant.startsWith('A04') || variant === 'A09/override')
		return 'The warehouse has 8 units of SKU A available today.';
	if (variant.startsWith('A02') || variant.startsWith('A05'))
		return 'R-19 email delivery remains unsupported in this static prototype. The writer supplied a two-sentence draft; no files were edited.';
	if (variant.startsWith('A03'))
		return 'No verified result was recorded. The private tool trace is outside the room evidence.';
	if (variant === 'A06/stale' || variant === 'A06/already-corrected')
		return 'The old 10-unit limit was withdrawn. The approved limit is 8 units; nothing was dispatched.';
	if (variant === 'A06/valid') return 'The approved limit is 8 units. Nothing was dispatched.';
	if (variant === 'A07/failure')
		return 'Capacity remains unknown because the stock service was unavailable. Nothing was dispatched.';
	if (variant === 'A07/waiting')
		return 'Dispatch remains blocked because owner authorization is missing.';
	if (variant === 'A08/follow-up' && input.includes('approved count'))
		return 'Mira owns R-19 at /prototype/R-19.html. The approved count is 8. Source-only verification leaves browser checks, tests, deployment, and release unverified.';
	if (variant === 'A08/follow-up')
		return 'Mira owns R-19 at /prototype/R-19.html. The approved count is corrected from 10 to 8. Source-only verification leaves browser checks and deployment unverified.';
	return 'The builder recorded /fixtures/build.txt and the reviewer confirmed the artifact.';
}
