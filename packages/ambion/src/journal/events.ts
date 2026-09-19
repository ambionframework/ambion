/** The room journal event vocabulary. */

import type { Attention, EndReason, Seq, TaskRecord, TaskStatus, TaskView } from '../types.ts';

/** One entry about an activation: it holds a lease, or its lease ended. */
export type LeaseChange =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: Seq }
	| { id: string; phase: 'ended'; reason: EndReason; at: string; readThrough: Seq };

/** A run took the name and fenced earlier runs. */
export interface Fence {
	at: string;
}

/** The room went quiet with an exchange open, and closed it. */
export interface Close {
	owner: string;
	from: Seq;
	through: Seq;
	at: string;
	/** The configured seated agent that writes a summary, when one is owed. */
	summary?: string;
}

/** A room-wide cancellation marker, with an optional close for open work. */
export interface Cancellation {
	at: string;
	close?: Omit<Close, 'summary'>;
}

/** One seat in a composition: its name, how the room knows it, and what wakes it. */
export interface Seating {
	name: string;
	identity: string;
	attention: Attention;
}

/** What a run started with. The roster folds from the latest one. */
export interface Composition {
	version: 2;
	goal?: string;
	/** The configured agent that writes summaries for human owners. */
	summary?: string;
	agents: Seating[];
	available: Seating[];
	/** Where the composition sits on the record. */
	seq: Seq;
	at: string;
	taskScope?: { room: string; exchange: Seq };
}

/** A durable change to Task state or its delivery obligations. */
export type TaskChange = TaskEventChange | TaskReceiptChange;

export type TaskEventChange =
	| {
			type: 'created';
			event: string;
			task: TaskRecord;
			sourceRoom: string;
			author: string;
			at: string;
			deliveries: readonly TaskDelivery[];
	  }
	| {
			type: 'updated';
			event: string;
			task: string;
			text: string;
			status: TaskStatus;
			outcome?: string;
			sourceRoom: string;
			author?: string;
			at: string;
			deliveries: readonly TaskDelivery[];
	  }
	| {
			type: 'instructed';
			event: string;
			task: string;
			text: string;
			sourceRoom: string;
			author: string;
			at: string;
			deliveries: readonly TaskDelivery[];
	  }
	| {
			type: 'idle';
			event: string;
			task: string;
			epoch: number;
			sourceRoom: string;
			at: string;
			deliveries: readonly TaskDelivery[];
	  };

type TaskReceiptChange =
	| { type: 'cancelling'; event: string; exchange: Seq; at: string }
	| { type: 'delivered'; event: string; delivery: string; seq: Seq; failure?: string; at: string }
	| { type: 'operation'; event: string; operation: TaskOperation; at: string }
	| {
			type: 'operation-result';
			event: string;
			operation: string;
			result: TaskOperationResult;
			at: string;
	  };

/** A source room accepts this operation while its calling lease is live. */
export interface TaskOperation {
	readonly id: string;
	readonly kind: 'update' | 'instruct';
	readonly task: string;
	readonly sourceRoom: string;
	readonly author: string;
	readonly version: string;
	readonly text: string;
	readonly status?: 'succeeded' | 'failed';
}

export type TaskOperationResult =
	{ task: string; room: string; status: TaskStatus } | { refused: string; task?: TaskView };

/** The destination message and its pinned facts have one stable identity. */
export interface TaskDelivery {
	readonly id: string;
	readonly room: string;
	readonly from: string;
	readonly to?: string;
	readonly text: string;
	readonly task: TaskView;
	readonly sourceRoom: string;
	readonly wake: boolean;
}
