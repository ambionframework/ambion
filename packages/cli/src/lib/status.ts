import type { ExchangeView, ParticipantInfo, RoomRead, Seq, Usage } from '@ambionframework/ambion';

export interface RoomStatus {
	name: string;
	participants: readonly ParticipantInfo[];
	state: 'idle' | 'working' | 'completed';
	/** What the exchange spent, as text. Absent when the room recorded no usage. */
	cost: string | undefined;
	/** The person the room waits on after the exchange closed. */
	awaiting: string | undefined;
}

/** The dollar cost when the room recorded one, else the token count. */
export function formatUsage(usage: Usage | undefined): string | undefined {
	if (usage === undefined) return undefined;
	if (usage.cost !== undefined) return `$${usage.cost.toFixed(4)}`;
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (total === 0) return undefined;
	return total < 1000 ? `${total} tokens` : `${(total / 1000).toFixed(1)}k tokens`;
}

/** Two totals added. `cost` stays absent until a step carries it. */
function addUsage(total: Usage | undefined, step: Usage): Usage {
	const cost =
		total?.cost === undefined && step.cost === undefined
			? undefined
			: (total?.cost ?? 0) + (step.cost ?? 0);
	return {
		input: (total?.input ?? 0) + step.input,
		output: (total?.output ?? 0) + step.output,
		cacheRead: (total?.cacheRead ?? 0) + step.cacheRead,
		cacheWrite: (total?.cacheWrite ?? 0) + step.cacheWrite,
		...(cost === undefined ? {} : { cost }),
	};
}

function usageOf(exchange: ExchangeView): Usage | undefined {
	if (exchange.status === 'closed') return exchange.usage;
	let total: Usage | undefined;
	for (const activation of exchange.activations) {
		if (activation.usage !== undefined) total = addUsage(total, activation.usage);
	}
	return total;
}

/** The exchange the terminal follows: the one it sent, else the open one, else the last. */
function followed(read: RoomRead, from: Seq | undefined): ExchangeView | undefined {
	if (from !== undefined) return read.exchanges.find((exchange) => exchange.from === from);
	return read.exchange ?? read.exchanges.at(-1);
}

function stateOf(
	read: RoomRead,
	from: Seq | undefined,
	exchange: ExchangeView | undefined,
): RoomStatus['state'] {
	if (from === undefined) {
		if (read.exchange !== undefined) return 'working';
		return exchange === undefined ? 'idle' : 'completed';
	}
	// A question just sent may not be on the record yet. It counts as work.
	return exchange === undefined || exchange.status === 'open' ? 'working' : 'completed';
}

/**
 * The status facts, derived from one room read. `from` is the sequence of a
 * question the terminal sent, and it selects that exchange.
 */
export function deriveStatus(read: RoomRead, from?: Seq): RoomStatus {
	const exchange = followed(read, from);
	return {
		name: read.name,
		participants: read.participants,
		state: stateOf(read, from, exchange),
		cost: exchange === undefined ? undefined : formatUsage(usageOf(exchange)),
		awaiting:
			exchange?.status === 'closed' && exchange.outcome.kind === 'awaiting'
				? exchange.outcome.person
				: undefined,
	};
}
