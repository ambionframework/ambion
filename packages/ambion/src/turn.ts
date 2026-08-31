/**
 * What a model's turn needs, wherever it is taken. A seat and an aide take
 * different turns for different reasons, and both open a downstream session,
 * persist what the model did, and report a turn that failed.
 */
import type {
	Agent,
	AgentToolResult,
	Session as PiSession,
	SessionRepo,
} from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import { renderLine } from './render.ts';
import type { Message } from './types.ts';

/** Open an id into its Pi session, creating it on first open. */
export async function openOrCreate(
	repo: SessionRepo,
	id: string,
	parentSessionId?: string,
): Promise<PiSession> {
	const known = (await repo.list()).find((metadata) => metadata.id === id);
	if (known) return repo.open(known);
	return repo.create(parentSessionId ? { id, parentSessionId } : { id });
}

/** Every turn a model took, in the downstream session that owns it. */
export async function persistTurns(open: Promise<PiSession>, agent: Agent): Promise<void> {
	const piSeat = await open;
	await piSeat.appendCustomEntry('ambion/activation', { at: new Date().toISOString() });
	for (const message of agent.state.messages) {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		await piSeat.appendMessage(JSON.parse(JSON.stringify(message)));
	}
}

export function runFailure(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The turn failed.');
	}
	return undefined;
}

export function userMessage(text: string): UserMessage {
	return { role: 'user', content: text, timestamp: Date.now() };
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/**
 * What a refused author is told. The runtime states what it missed; the
 * sentences around that belong to the kind of writing it was doing.
 */
export function refusal(opening: string, missed: Message[], advice: string): string {
	return [opening, ...missed.map(renderLine), advice].join('\n');
}

/** What a write tool returns when the record took it. */
export function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
}
