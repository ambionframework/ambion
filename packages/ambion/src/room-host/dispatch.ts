/**
 * Ports and delivery. The journal hears every entry once, and each entry
 * queues its reaction here: what the host hears, who is steered, and which
 * port gets a wake or a cut. A delivery result carries a token, so a late
 * reply from an earlier delivery changes nothing.
 */

import type { ExecutionConnector } from '../host/runtime.ts';
import type { Close, LeaseChange } from '../journal/events.ts';
import { type Entry, placed } from '../journal/journal.ts';
import type { AgentPort, RoomProtocol, Steer } from '../protocol.ts';
import { activationSpec } from '../room/activation.ts';
import { isLive, seatOf } from '../room/lease.ts';
import type { AgentDefinition, ClosedExchange, Seq } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { RoomBase } from './core.ts';

type DeliveryOperation = 'wake' | 'steer' | 'cut';

export interface DeliveryState {
	activation: string;
	token: number;
	pending: boolean;
	failed: boolean;
}

/** What delivery needs of the room. */
export interface DispatchHost extends RoomBase {
	/** The configured execution owner for this room's seats. */
	readonly connector: ExecutionConnector;
	readonly defs: ReadonlyMap<string, AgentDefinition>;
	readonly ports: Map<string, AgentPort>;
	/** The three room calls exposed to an in-process seat. */
	readonly calls: RoomProtocol;
	/** When this room last sent each wake. A cache: a resumed room sends every pending wake again. */
	readonly sentAt: Map<string, number>;
	/** Delivery state is bounded by currently due/live activations and fences late replies by token. */
	readonly deliveryStates: Map<string, DeliveryState>;
	/** Every lease id this room has heard a change for. It says `activation_start` once. */
	readonly heardLeases: Set<string>;
	/** Publications run in journal order after the confirmed entry has been folded. */
	publications: Promise<void>;
	evicted(): boolean;
	notifyExchangeWaiters(): void;
}

/** What the room does with one entry. The journal calls it for every entry it takes after the replay. */
export function hearEntry(host: DispatchHost, entry: Entry): void {
	if (entry.kind === 'message') queueMessage(host, entry);
	else if (entry.kind === 'close') queueClose(host, entry.body);
	else if (entry.kind === 'lease') queueLease(host, entry.body, opens(host, entry.body.id));
	else if (entry.kind === 'cancel') queueCancellation(host, entry.body.close, entry.seq);
	// Membership, cancellation, and lease entries can make an earlier
	// delivery obsolete without dispatching another message immediately.
	pruneDeliveryErrors(host);
}

/** Queue one captured publication without making journal confirmation await listeners or transport. */
function publish(host: DispatchHost, effect: () => void): void {
	host.publications = host.publications.then(() => {
		if (host.evicted()) return;
		try {
			effect();
		} catch {
			// External publication is best effort after the durable fact is confirmed.
		}
	});
}

/**
 * Whether this change starts an activation: the room has heard no earlier
 * change for the id. The room keeps the set, because the question is the room's:
 * it says `activation_start` once. The replay seeds it from the fold, so a
 * resumed room starts no activation the last run already started.
 */
function opens(host: DispatchHost, id: string): boolean {
	const first = !host.heardLeases.has(id);
	host.heardLeases.add(id);
	return first;
}

/** Every lease id the room has heard a change for, seeded by the replay. */
export function seedHeardLeases(host: DispatchHost): void {
	for (const id of host.state().leases.keys()) host.heardLeases.add(id);
}

/**
 * A message on the record: the host hears about it, then what it opened,
 * steers every active ordinary seat, and asks reconciliation to dispatch
 * the pending activations the projection derives. One message, one event,
 * one order.
 */
function queueMessage(host: DispatchHost, entry: Extract<Entry, { kind: 'message' }>): void {
	const message = copyMessage(placed(entry));
	const state = host.state();
	const exchange = state.exchange?.from === message.seq ? { ...state.exchange } : undefined;
	const delivery = state.deliveries.get(message.seq);
	const after = state.messages.filter((candidate) => candidate.seq < message.seq).at(-1)?.seq ?? 0;
	const steers: Steer[] = [];
	for (const target of delivery?.steers ?? []) {
		const lease = state.leases.get(target.activation);
		if (lease === undefined || !isLive(lease, host.now())) continue;
		steers.push({
			room: host.name,
			seat: target.seat,
			activation: target.activation,
			after,
			message: copyMessage(message),
		});
	}
	publish(host, () => {
		host.emit({ type: 'message', message });
		if (exchange !== undefined) host.emit({ type: 'exchange_opened', exchange });
		for (const steer of steers) steerTarget(host, steer);
		host.notifyExchangeWaiters();
		void host.reconcile();
	});
}

/**
 * An exchange ended at the range the close names. The host hears it
 * before any closing summary. A question that landed
 * ahead of the close opens the next exchange, and the room says so.
 */
function queueClose(host: DispatchHost, close: Close): void {
	const question = host.state().messages.find((m) => m.seq === close.from);
	const exchange: ClosedExchange = {
		owner: close.owner,
		from: close.from,
		at: question?.at ?? close.at,
		through: close.through,
	};
	const next = host.state().exchange;
	const opened = next === undefined ? undefined : { ...next };
	publish(host, () => {
		host.emit({ type: 'exchange_closed', exchange });
		if (opened !== undefined) host.emit({ type: 'exchange_opened', exchange: opened });
		host.notifyExchangeWaiters();
	});
}

/** A cancellation closes its current exchange and cuts every lease it superseded. */
function queueCancellation(host: DispatchHost, close: Close | undefined, seq: Seq): void {
	const state = host.state();
	const revoked = [...state.leases.values()].filter(
		(lease) => lease.phase === 'ended' && lease.reason === 'revoked' && lease.until === seq,
	);
	host.sentAt.clear();
	if (close !== undefined) queueClose(host, close);
	publish(host, () => {
		for (const lease of revoked) {
			const seat = seatOf(lease.id);
			if (seat === undefined) continue;
			cutPort(host, seat, lease.id);
			if (host.heardLeases.has(lease.id))
				host.emit({
					type: 'activation_end',
					agent: seat,
					activation: lease.id,
					spoke: state.messages.some((message) => message.activationId === lease.id),
				});
		}
		host.notifyExchangeWaiters();
	});
}

/**
 * A lease change: the first change of an id starts an activation, and an
 * end ends one. A change that ends a lease the journal never held is a
 * wake written off, and starts nothing.
 */
function queueLease(host: DispatchHost, lease: LeaseChange, first: boolean): void {
	const seat = seatOf(lease.id) ?? '';
	if (lease.phase === 'running') {
		publish(host, () => {
			if (first) host.emit({ type: 'activation_start', agent: seat, activation: lease.id });
			// A claim that lost its confirmation never armed the expiry: this pass does.
			void host.reconcile();
			host.notifyExchangeWaiters();
		});
		return;
	}
	const revoked = lease.reason === 'revoked';
	if (first) {
		// A change that ends a lease the journal never held is an attempt nobody made.
		publish(host, () => {
			if (revoked) cutPort(host, seat, lease.id);
			if (lease.reason === 'abandoned') {
				host.emit({
					type: 'abandoned',
					agent: seat,
					activation: lease.id,
					cause: lease.cause ?? 'transient',
				});
				void host.reconcile();
			}
			host.notifyExchangeWaiters();
		});
		return;
	}
	const spoke = host.state().messages.some((m) => m.activationId === lease.id);
	publish(host, () => {
		if (revoked) cutPort(host, seat, lease.id);
		host.emit({
			type: 'activation_end',
			agent: seat,
			activation: lease.id,
			spoke,
			...(lease.usage === undefined ? {} : { usage: lease.usage }),
		});
		host.notifyExchangeWaiters();
		if (lease.reason === 'expired')
			host.emit({
				type: 'error',
				agent: seat,
				activation: lease.id,
				error: new Error('The activation ran past its lease.'),
			});
	});
}

/**
 * Send projected ordinary targets when their recorded lease is live now.
 * The delivery projection excludes authors and context-bound activations.
 */
function steerTarget(host: DispatchHost, steer: Steer): void {
	if (activationSpec(steer.activation, host.state()) === undefined) return;
	dispatch(host, steer.seat, 'steer', steer.activation, (port) => port.steer(steer));
}

/** One activation wake over the wire. */
export function sendWake(host: DispatchHost, id: string, seat: string): void {
	if (activationSpec(id, host.state()) === undefined) return;
	host.sentAt.set(id, host.now());
	dispatch(host, seat, 'wake', id, (port) => port.wake({ room: host.name, seat, activation: id }));
}

function cutPort(host: DispatchHost, seat: string, activation: string): void {
	dispatch(host, seat, 'cut', activation, (port) => port.cut(activation));
}

/** Contain synchronous connector faults and asynchronous transport rejection independently. */
function dispatch(
	host: DispatchHost,
	seat: string,
	operation: DeliveryOperation,
	activation: string,
	send: (port: AgentPort) => Promise<void>,
): void {
	if (host.evicted()) return;
	pruneDeliveryErrors(host);
	const key = JSON.stringify([seat, operation, activation]);
	const previous = host.deliveryStates.get(key);
	if (previous?.pending && !previous.failed) {
		previous.failed = true;
		emitDeliveryError(
			host,
			seat,
			operation,
			activation,
			new Error('The previous delivery result is still pending; its outcome is unknown.'),
		);
	}
	const state: DeliveryState = previous ?? {
		activation,
		token: 0,
		pending: false,
		failed: false,
	};
	const token = state.token + 1;
	state.token = token;
	state.pending = true;
	host.deliveryStates.set(key, state);
	const report = (error: unknown) => {
		const current = host.deliveryStates.get(key);
		if (
			host.gone() ||
			current?.token !== token ||
			(operation !== 'cut' && !deliveryActive(host, activation))
		)
			return;
		current.pending = false;
		if (current.failed) return;
		current.failed = true;
		emitDeliveryError(host, seat, operation, activation, error);
	};
	try {
		const result = send(portFor(host, seat));
		void result.then(() => {
			const current = host.deliveryStates.get(key);
			if (current?.token !== token) return;
			current.pending = false;
			current.failed = false;
		}, report);
	} catch (error) {
		report(error);
	}
}

function deliveryActive(host: DispatchHost, activation: string): boolean {
	return (
		host.state().due.some((work) => work.id === activation) ||
		host.state().leases.get(activation)?.phase === 'running'
	);
}

/** Remove failures for activations that are no longer pending or live. */
function pruneDeliveryErrors(host: DispatchHost): void {
	const active = new Set([
		...host.state().due.map((work) => work.id),
		...[...host.state().leases.values()]
			.filter((lease) => lease.phase === 'running')
			.map((lease) => lease.id),
	]);
	for (const [key, state] of host.deliveryStates)
		if (!active.has(state.activation)) host.deliveryStates.delete(key);
}

/** Report a failed or unknown delivery without changing the journal result. */
function emitDeliveryError(
	host: DispatchHost,
	seat: string,
	operation: DeliveryOperation,
	activation: string,
	error: unknown,
): void {
	host.emit({
		type: 'delivery_error',
		agent: seat,
		activation,
		operation,
		error: error instanceof Error ? error : new Error(String(error)),
	});
}

function portFor(host: DispatchHost, seat: string): AgentPort {
	let port = host.ports.get(seat);
	if (port === undefined) {
		const definition = host.defs.get(seat);
		if (definition === undefined)
			throw new Error(`Room '${host.name}' has no binding for '${seat}'.`);
		port = host.connector.connect(host.calls, {
			room: host.name,
			seat,
			definition,
			emit: (event) => host.emit(event),
		});
		host.ports.set(seat, port);
	}
	return port;
}
