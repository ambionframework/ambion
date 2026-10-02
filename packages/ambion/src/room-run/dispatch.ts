/**
 * Ports and delivery. The journal hears every entry once, and each entry
 * queues its reaction here: what the host hears, who is steered, and which
 * port gets a wake or a cut. A delivery result carries a token, so a late
 * reply from an earlier delivery changes nothing.
 */

import type { Close, Lease } from '../journal/entries.ts';
import { placed, type RoomEntry } from '../journal/journal.ts';
import type { AgentPort, Steer } from '../protocol.ts';
import { activationSpec } from '../room/activation.ts';
import { seatOf } from '../room/lease.ts';
import { isLive } from '../room/rules.verified.ts';
import type { ExchangeRange, Seq } from '../types.ts';
import { copyMessage } from '../types.ts';
import type { DeliveryState, RoomRunState } from './core.ts';

type DeliveryOperation = 'wake' | 'steer' | 'cut';

/** What the room does with one entry. The journal calls it for every entry it takes after the replay. */
export function hearEntry(run: RoomRunState, entry: RoomEntry): void {
	if (entry.kind === 'message') queueMessage(run, entry);
	else if (entry.kind === 'close') queueCloses(run);
	else if (entry.kind === 'lease') queueLease(run, entry.body, opens(run, entry.body.id));
	else if (entry.kind === 'cancel') queueCancellation(run, entry.seq);
	// Membership, cancellation, and lease entries can make an earlier
	// delivery obsolete without dispatching another message immediately.
	pruneDeliveryErrors(run);
}

/**
 * Queue one captured publication without making journal confirmation await
 * listeners or transport. Each caller that waits on an exchange hears it after
 * the effect, since each entry the room hears can change what a waiter looks for.
 */
function publish(run: RoomRunState, effect: () => void): void {
	run.publications = run.publications.then(() => {
		if (run.evicted()) return;
		try {
			effect();
		} catch {
			// External publication is best effort after the durable fact is confirmed.
		}
		run.notifyExchangeWaiters();
	});
}

/**
 * Whether this change starts an activation: the room has heard no earlier
 * change for the id. The room keeps the set, because the question is the room's:
 * it says `activation_start` once. The replay seeds it from the fold, so a
 * resumed room starts no activation the last run already started.
 */
function opens(run: RoomRunState, id: string): boolean {
	const first = !run.heardLeases.has(id);
	run.heardLeases.add(id);
	return first;
}

/** Every lease id and every close the room has heard, seeded by the replay. */
export function seedHeard(run: RoomRunState): void {
	const state = run.state();
	for (const id of state.leases.keys()) run.heardLeases.add(id);
	run.heardCloses = state.closes.length;
}

/**
 * A message on the record: the host hears about it, then what it opened,
 * steers every active ordinary seat, and asks reconciliation to dispatch
 * the pending activations the projection derives. One message, one entry,
 * one order.
 */
function queueMessage(run: RoomRunState, entry: Extract<RoomEntry, { kind: 'message' }>): void {
	const message = copyMessage(placed(entry));
	const state = run.state();
	const exchange = state.exchange?.from === message.seq ? { ...state.exchange } : undefined;
	const delivery = state.deliveries.get(message.seq);
	const after = state.messages.filter((candidate) => candidate.seq < message.seq).at(-1)?.seq ?? 0;
	const steers: Steer[] = [];
	for (const target of delivery?.steers ?? []) {
		const lease = state.leases.get(target.activation);
		if (lease === undefined || !isLive(lease, run.now())) continue;
		steers.push({
			room: run.name,
			seat: target.seat,
			activation: target.activation,
			after,
			message: copyMessage(message),
		});
	}
	publish(run, () => {
		run.emit({ type: 'message', message });
		if (exchange !== undefined) run.emit({ type: 'exchange_opened', exchange });
		for (const steer of steers) steerTarget(run, steer);
		void run.reconcile();
	});
}

/**
 * Every close the room has not heard yet. A close entry adds one to the
 * state, and a cancellation adds one when it finds an exchange open.
 */
function queueCloses(run: RoomRunState): void {
	const { closes } = run.state();
	for (const close of closes.slice(run.heardCloses)) queueClose(run, close);
	run.heardCloses = closes.length;
}

/**
 * An exchange ended at the range the close names. The host hears it
 * before any closing summary. A question that landed
 * ahead of the close opens the next exchange, and the room says so.
 */
function queueClose(run: RoomRunState, close: Close): void {
	const question = run.state().messages.find((m) => m.seq === close.from);
	const exchange: ExchangeRange = {
		...(close.person === undefined ? {} : { person: close.person }),
		from: close.from,
		at: question?.at ?? close.at,
		through: close.through,
	};
	const next = run.state().exchange;
	const opened = next === undefined ? undefined : { ...next };
	publish(run, () => {
		run.emit({ type: 'exchange_closed', exchange });
		if (opened !== undefined) run.emit({ type: 'exchange_opened', exchange: opened });
	});
}

/** A cancellation closes its current exchange and cuts every lease it superseded. */
function queueCancellation(run: RoomRunState, seq: Seq): void {
	const state = run.state();
	const revoked = [...state.leases.values()].filter(
		(lease) => lease.phase === 'ended' && lease.reason === 'revoked' && lease.until === seq,
	);
	run.sentAt.clear();
	queueCloses(run);
	publish(run, () => {
		for (const lease of revoked) {
			const seat = seatOf(lease.id);
			if (seat === undefined) continue;
			cutPort(run, seat, lease.id);
			if (run.heardLeases.has(lease.id))
				run.emit({
					type: 'activation_end',
					seat,
					activation: lease.id,
					said: state.messages.some((message) => message.activation === lease.id),
				});
		}
	});
}

/**
 * A lease change: the first change of an id starts an activation, and an
 * end ends one. A change that ends a lease the journal never held is a
 * wake written off, and starts nothing.
 */
function queueLease(run: RoomRunState, lease: Lease, first: boolean): void {
	const seat = seatOf(lease.id) ?? '';
	if (lease.phase === 'running') {
		publish(run, () => {
			if (first) run.emit({ type: 'activation_start', seat, activation: lease.id });
			// A claim that lost its confirmation never armed the expiry: this pass does.
			void run.reconcile();
		});
		return;
	}
	const revoked = lease.reason === 'revoked';
	if (first) {
		// A change that ends a lease the journal never held is an attempt nobody made.
		publish(run, () => {
			if (revoked) cutPort(run, seat, lease.id);
			if (lease.reason === 'abandoned') {
				run.emit({
					type: 'abandoned',
					seat,
					activation: lease.id,
					cause: lease.cause ?? 'transient',
				});
				void run.reconcile();
			}
		});
		return;
	}
	const said = run.state().messages.some((m) => m.activation === lease.id);
	publish(run, () => {
		if (revoked) cutPort(run, seat, lease.id);
		run.emit({
			type: 'activation_end',
			seat,
			activation: lease.id,
			said,
			...(lease.usage === undefined ? {} : { usage: lease.usage }),
		});
		if (lease.reason === 'expired')
			run.emit({
				type: 'error',
				seat,
				activation: lease.id,
				error: new Error('The activation ran past its lease.'),
			});
	});
}

/**
 * Send projected ordinary targets when their recorded lease is live now.
 * The delivery projection excludes authors and context-bound activations.
 */
function steerTarget(run: RoomRunState, steer: Steer): void {
	if (activationSpec(steer.activation, run.state()) === undefined) return;
	dispatch(run, steer.seat, 'steer', steer.activation, (port) => port.steer(steer));
}

/** One activation wake over the wire. */
export function sendWake(run: RoomRunState, id: string, seat: string): void {
	if (activationSpec(id, run.state()) === undefined) return;
	run.sentAt.set(id, run.now());
	dispatch(run, seat, 'wake', id, (port) => port.wake({ room: run.name, seat, activation: id }));
}

function cutPort(run: RoomRunState, seat: string, activation: string): void {
	dispatch(run, seat, 'cut', activation, (port) => port.cut(activation));
}

/** Contain synchronous connector faults and asynchronous port rejection independently. */
function dispatch(
	run: RoomRunState,
	seat: string,
	operation: DeliveryOperation,
	activation: string,
	send: (port: AgentPort) => Promise<void>,
): void {
	if (run.evicted()) return;
	pruneDeliveryErrors(run);
	const key = JSON.stringify([seat, operation, activation]);
	const previous = run.deliveryStates.get(key);
	if (previous?.pending && !previous.failed) {
		previous.failed = true;
		emitDeliveryError(
			run,
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
	run.deliveryStates.set(key, state);
	const report = (error: unknown) => {
		const current = run.deliveryStates.get(key);
		if (
			run.gone() ||
			current?.token !== token ||
			(operation !== 'cut' && !deliveryActive(run, activation))
		)
			return;
		current.pending = false;
		if (current.failed) return;
		current.failed = true;
		emitDeliveryError(run, seat, operation, activation, error);
	};
	try {
		const result = send(portFor(run, seat));
		void result.then(() => {
			const current = run.deliveryStates.get(key);
			if (current?.token !== token) return;
			current.pending = false;
			current.failed = false;
		}, report);
	} catch (error) {
		report(error);
	}
}

function deliveryActive(run: RoomRunState, activation: string): boolean {
	return (
		run.state().due.some((work) => work.id === activation) ||
		run.state().leases.get(activation)?.phase === 'running'
	);
}

/** Remove failures for activations that are no longer pending or live. */
function pruneDeliveryErrors(run: RoomRunState): void {
	const active = new Set([
		...run.state().due.map((work) => work.id),
		...[...run.state().leases.values()]
			.filter((lease) => lease.phase === 'running')
			.map((lease) => lease.id),
	]);
	for (const [key, state] of run.deliveryStates)
		if (!active.has(state.activation)) run.deliveryStates.delete(key);
}

/** Report a failed or unknown delivery without changing the journal result. */
function emitDeliveryError(
	run: RoomRunState,
	seat: string,
	operation: DeliveryOperation,
	activation: string,
	error: unknown,
): void {
	run.emit({
		type: 'delivery_error',
		seat,
		activation,
		operation,
		error: error instanceof Error ? error : new Error(String(error)),
	});
}

function portFor(run: RoomRunState, seat: string): AgentPort {
	let port = run.ports.get(seat);
	if (port === undefined) {
		const definition = run.defs.get(seat);
		if (definition === undefined)
			throw new Error(`Room '${run.name}' has no binding for '${seat}'.`);
		port = run.connector.connect(run.calls, {
			room: run.name,
			seat,
			definition,
			emit: (event) => run.emit(event),
		});
		run.ports.set(seat, port);
	}
	return port;
}
