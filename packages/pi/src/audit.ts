/**
 * The audit of a seat: the turns a model took, written to the downstream
 * Pi session that the seat owns. The audit records what happened. It never
 * changes what the room does about it.
 */
import type { AuditSession as PiSession } from '@ambionframework/pi-journal';
import type { AgentMessage, Agent as PiAgent } from '@earendil-works/pi-agent-core';

/** Audit gets one retry for a lost or refused write in this activation. */
const AUDIT_ATTEMPTS = 2;

/**
 * Every turn a model took from message `from` on, in the downstream session
 * that owns it. The first write of an activation, at `from` zero, opens with
 * the `ambion/activation` entry. A later pass of the same activation adds
 * its turns to the entries already written.
 */
export async function persistTurns(
	open: () => Promise<PiSession>,
	agent: PiAgent,
	at: string,
	from = 0,
): Promise<void> {
	const batch = crypto.randomUUID();
	const messages = agent.state.messages.slice(from).map((message) => {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		return JSON.parse(JSON.stringify(message)) as AgentMessage;
	});
	for (let attempt = 0; attempt < AUDIT_ATTEMPTS; attempt += 1) {
		try {
			const piSeat = await open();
			if (from === 0) {
				await piSeat.appendEntry(
					{
						type: 'custom',
						id: `${batch}:activation`,
						customType: 'ambion/activation',
						data: { at },
					},
					'main',
				);
			}
			for (const [index, message] of messages.entries()) {
				await piSeat.appendEntry(
					{
						type: 'message',
						id: `${batch}:message:${index}`,
						message,
					},
					'main',
				);
			}
			return;
		} catch (error) {
			if (attempt === AUDIT_ATTEMPTS - 1) throw error;
		}
	}
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
