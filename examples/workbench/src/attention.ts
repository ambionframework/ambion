import type { ExchangeActivation, ExchangeView } from '@ambionframework/ambion';
import type { Approval, RoomView } from './workbench.ts';

/**
 * The newest activation of an exchange that ran, or undefined when it has
 * none. The room abandons an attempt without running it, so an abandoned
 * attempt has no steps. It counts only when no other activation exists.
 */
export function newest(exchange: ExchangeView | undefined): ExchangeActivation | undefined {
	const activations = exchange?.activations ?? [];
	return (
		activations.findLast((activation) => activation.outcome.status !== 'abandoned') ??
		activations.at(-1)
	);
}

/** The exchange a person names: by ordinal, oldest first, or the latest with an activation. */
export function pick(
	exchanges: readonly ExchangeView[],
	argument: string,
): ExchangeView | undefined {
	if (argument === '') return [...exchanges].reverse().find((exchange) => newest(exchange));
	const ordinal = Number(argument);
	return Number.isInteger(ordinal) ? exchanges[ordinal - 1] : undefined;
}

/** What the person owes the room: replies that wait on them and operations that wait on their answer. */
export function attentionOf(
	view: RoomView | undefined,
	person: string,
	approvals: readonly Approval[],
): string[] {
	if (!view || !person) return [];
	// `pendingFor` reads a `RoomRead`, and the host view overrides `goal`, so filter here.
	const replies = view.exchanges
		.filter(
			(exchange) =>
				exchange.status === 'closed' &&
				exchange.outcome.kind === 'awaiting' &&
				exchange.outcome.person === person,
		)
		.map((exchange) => `The exchange from message ${exchange.from} waits for your reply.`);
	const operations = approvals
		.filter((approval) => approval.owner === person)
		.map(
			(approval) =>
				`Operation ${approval.id} needs your answer: ${approval.instrument} to ${approval.setpoint} ${approval.unit} is above its limit. Say allow or deny in the room, and the agent records it.`,
		);
	return [...replies, ...operations];
}
