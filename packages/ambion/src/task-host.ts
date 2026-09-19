/** Task operations and durable delivery over cohosted room journals. */
import type {
	TaskChange,
	TaskDelivery,
	TaskEventChange,
	TaskOperation,
	TaskOperationResult,
} from './journal/events.ts';
import type {
	TaskCreateRequest,
	TaskResponse,
	TaskSayRequest,
	TaskToolResult,
	TaskUpdateRequest,
	ViewResponse,
} from './protocol.ts';
import { activationSpec } from './room/activation.ts';
import type { RoomState } from './room/fold.ts';
import { isLive } from './room/lease.ts';
import { liveWork } from './room/reconcile.ts';
import {
	taskCreationAllowed,
	taskMutationAllowed,
	taskTransitionAllowed,
} from './room/task-authority.ts';
import { taskIdleDecision } from './room/task-idle.ts';
import { changedTask, createdTask, taskContext } from './room/tasks.ts';
import type { TaskRecord, TaskView } from './types.ts';

export interface TaskHostPort {
	readonly name: string;
	readonly ready: Promise<void>;
	now(): number;
	state(): RoomState;
	gone(): boolean;
	catalog(): readonly string[];
	progress(): boolean;
	get(name: string): TaskHost | undefined;
	ensure(task: TaskRecord): Promise<TaskHost>;
	write(key: string, decide: () => TaskChange): Promise<TaskChange>;
	deliver(delivery: TaskDelivery): Promise<number>;
	view(activation: string): Promise<ViewResponse>;
	changed(): void;
	stop(): Promise<void>;
	cancel(key: string): Promise<void>;
}

/** Refusals carry fresh context through the seat protocol. */
class TaskConflict extends Error {
	readonly task?: TaskView;
	constructor(message: string, task?: TaskView) {
		super(message);
		this.task = task;
	}
}

function operationKey(room: string, activation: string, key: string): string {
	if (!key.trim()) throw new Error('A Task operation requires a key.');
	return JSON.stringify(['task-operation', room, activation, key]);
}

const at = (host: TaskHostPort) => new Date(host.now()).toISOString();
const resultOf = (task: TaskRecord): TaskToolResult => ({
	task: task.id,
	room: task.workingRoom,
	status: task.status,
});
const version = (task: TaskView) => task.events.at(-1)?.id ?? '';

export class TaskHost {
	private draining: Promise<void> | undefined;
	readonly host: TaskHostPort;
	constructor(host: TaskHostPort) {
		this.host = host;
	}

	private changes(): readonly TaskChange[] {
		return [...(this.host.state().taskChanges?.values() ?? [])];
	}
	private tasks(): readonly TaskView[] {
		return [...(this.host.state().tasks?.values() ?? [])];
	}
	private recorded(key: string): TaskChange | undefined {
		return this.host.state().taskChanges?.get(key);
	}

	async create(input: TaskCreateRequest): Promise<TaskResponse> {
		const request = structuredClone(input);
		await this.host.ready;
		return this.answer(request.activation, async () => {
			const key = operationKey(this.host.name, request.activation, request.key);
			const recorded = await this.host.write(key, () => this.creation(request, key));
			if (recorded.type !== 'created')
				throw new Error('The operation key belongs to another Task operation.');
			this.host.changed();
			return resultOf(recorded.task);
		});
	}

	private creation(request: TaskCreateRequest, key: string): TaskChange {
		const owner = this.author(request.activation, request.readThrough);
		const state = this.host.state();
		const exchange = state.exchange;
		const workingRoom = state.composition?.taskScope !== undefined;
		if (
			!taskCreationAllowed({
				origin: !workingRoom,
				exchangeOpen: exchange !== undefined,
			})
		) {
			if (workingRoom) throw new Error('Working rooms cannot create Tasks.');
			if (exchange === undefined) throw new Error('A Task requires an open exchange.');
			throw new Error('The Task activation is stale.');
		}
		if ((request.agents === undefined) === (request.room === undefined))
			throw new Error('A Task requires exactly one of agents or room.');
		if (exchange === undefined) throw new Error('A Task requires an open exchange.');
		const selected = this.selection(request, exchange.from);
		const task: TaskRecord = {
			id: `task-${crypto.randomUUID()}`,
			text: this.text(request.text),
			owner,
			originRoom: this.host.name,
			exchange: exchange.from,
			workingRoom: selected.room,
			agents: selected.agents,
			subscriptions: [{ room: this.host.name, agent: owner, progress: this.host.progress() }],
			status: 'open',
			createdAt: at(this.host),
		};
		const change: Extract<TaskEventChange, { type: 'created' }> = {
			type: 'created',
			event: key,
			task,
			sourceRoom: this.host.name,
			author: owner,
			at: task.createdAt,
			deliveries: [],
		};
		return {
			...change,
			deliveries: [this.delivery(createdTask(change), key, task.workingRoom, owner, task.text)],
		};
	}

	private selection(request: TaskCreateRequest, exchange: number) {
		if (request.room !== undefined) {
			const prior = this.tasks().find(
				(task) =>
					task.originRoom === this.host.name &&
					task.exchange === exchange &&
					task.workingRoom === request.room,
			);
			if (prior === undefined) throw new Error('The working room must belong to this exchange.');
			return { room: prior.workingRoom, agents: prior.agents };
		}
		if (!Array.isArray(request.agents)) throw new Error('Task agents must be a nonempty list.');
		const agents = [...new Set(request.agents)];
		if (agents.length === 0) throw new Error('A new working room requires agents.');
		for (const name of agents)
			if (!this.host.catalog().includes(name)) throw new Error(`Unknown agent '${name}'.`);
		return { room: `task-room-${crypto.randomUUID()}`, agents };
	}

	update(request: TaskUpdateRequest): Promise<TaskResponse> {
		return this.operate(structuredClone(request), 'update');
	}
	say(request: TaskSayRequest): Promise<TaskResponse> {
		return this.operate(structuredClone(request), 'instruct');
	}

	private async operate(
		request: TaskUpdateRequest,
		kind: TaskOperation['kind'],
	): Promise<TaskResponse> {
		await this.host.ready;
		return this.answer(request.activation, async () => {
			const key = operationKey(this.host.name, request.activation, request.key);
			const receipt = await this.host.write(key, () => ({
				type: 'operation',
				event: key,
				operation: this.operation(request, kind, key),
				at: at(this.host),
			}));
			if (receipt.type !== 'operation')
				throw new Error('The operation key belongs to another Task operation.');
			const result = await this.forward(receipt.operation);
			await this.host.get(this.requireTask(request.task).originRoom)?.drain();
			this.host.changed();
			return result;
		});
	}

	private operation(
		request: TaskUpdateRequest,
		kind: TaskOperation['kind'],
		id: string,
	): TaskOperation {
		if (
			request.status !== undefined &&
			request.status !== 'succeeded' &&
			request.status !== 'failed'
		)
			throw new Error("A Task status must be 'succeeded' or 'failed'.");
		const author = this.author(request.activation, request.readThrough);
		const task = this.requireTask(request.task);
		this.assertMutationAuthority(task, author, kind);
		this.open(task);
		return {
			id,
			kind,
			task: task.id,
			sourceRoom: this.host.name,
			author,
			version: version(task),
			text: this.text(request.text),
			...(request.status === undefined ? {} : { status: request.status }),
		};
	}

	private assertMutationAuthority(
		task: TaskView,
		author: string,
		kind: TaskOperation['kind'],
	): void {
		const origin = task.originRoom === this.host.name;
		const working = task.workingRoom === this.host.name;
		const steering = kind === 'instruct';
		if (
			taskMutationAllowed({
				origin,
				owner: task.owner === author,
				working,
				steering,
			})
		)
			return;
		if (origin && task.owner !== author)
			throw new Error('Only the owner can act on this Task from its originating room.');
		if (!origin && !working) throw new Error('This Task is not attached to this room.');
		if (steering && !origin) throw new Error('Only the owner can steer a Task.');
	}

	private async forward(operation: TaskOperation): Promise<TaskOperationResult> {
		const resultKey = `${operation.id}:result`;
		const prior = this.recorded(resultKey);
		if (prior?.type === 'operation-result') return prior.result;
		const task = this.requireTask(operation.task);
		const origin = this.host.get(task.originRoom);
		if (origin === undefined) throw new Error('The Task authority is unavailable.');
		const result = await origin.accept(operation, this);
		const written = await this.host.write(resultKey, () => ({
			type: 'operation-result',
			event: resultKey,
			operation: operation.id,
			result,
			at: at(this.host),
		}));
		if (written.type !== 'operation-result') throw new Error('Invalid Task operation receipt.');
		return written.result;
	}

	private async accept(operation: TaskOperation, source: TaskHost): Promise<TaskOperationResult> {
		const key = `${operation.id}:accepted`;
		try {
			const written = await this.host.write(key, () => this.accepted(operation, source, key));
			if (written.type === 'updated')
				return { ...resultOf(this.requireTask(operation.task)), status: written.status };
			return { ...resultOf(this.requireTask(operation.task)), status: 'open' };
		} catch (error) {
			if (!(error instanceof TaskConflict)) throw error;
			return { refused: error.message, ...(error.task === undefined ? {} : { task: error.task }) };
		}
	}

	private accepted(operation: TaskOperation, source: TaskHost, key: string): TaskChange {
		const receipt = source.recorded(operation.id);
		if (
			receipt?.type !== 'operation' ||
			JSON.stringify(receipt.operation) !== JSON.stringify(operation)
		)
			throw new Error('The source room has not accepted this operation.');
		const task = this.requireTask(operation.task);
		if (this.cancelling() !== undefined)
			throw new TaskConflict('The owning exchange is being cancelled.', task);
		this.open(task);
		if (task.exchange !== this.host.state().exchange?.from)
			throw new TaskConflict('The owning exchange has ended.', task);
		if (version(task) !== operation.version)
			throw new TaskConflict(
				'The Task changed. Read its current state before deciding again.',
				task,
			);
		const base = {
			event: key,
			task: task.id,
			text: operation.text,
			sourceRoom: operation.sourceRoom,
			author: operation.author,
			at: at(this.host),
			deliveries: [],
		};
		const change: TaskEventChange =
			operation.kind === 'instruct'
				? { ...base, type: 'instructed' }
				: {
						...base,
						type: 'updated',
						status: operation.status ?? 'open',
						...(operation.status === undefined ? {} : { outcome: operation.text }),
					};
		const next = changedTask(task, change);
		return { ...change, deliveries: this.eventDeliveries(next, change) };
	}

	private eventDeliveries(
		task: TaskView,
		change: Exclude<TaskEventChange, { type: 'created' }>,
	): TaskDelivery[] {
		const from = 'author' in change && change.author !== undefined ? change.author : 'runtime';
		const text =
			change.type === 'idle'
				? 'The working room is idle. Resume the work or settle this Task.'
				: change.text;
		const report = `Task ${task.id} is ${task.status}. ${text}`;
		const deliveries =
			change.type === 'idle'
				? []
				: [
						this.delivery(
							task,
							change.event,
							task.workingRoom,
							from,
							report,
							undefined,
							change.sourceRoom,
							change.type === 'instructed',
						),
					];
		if (change.type === 'instructed') return deliveries;
		for (const subscription of task.subscriptions) {
			if (change.type === 'updated' && task.status === 'open' && !subscription.progress) continue;
			deliveries.push(
				this.delivery(
					task,
					change.event,
					subscription.room,
					from,
					report,
					subscription.agent,
					change.sourceRoom,
				),
			);
		}
		return deliveries;
	}

	private delivery(
		task: TaskView,
		event: string,
		room: string,
		from: string,
		text: string,
		to?: string,
		sourceRoom = this.host.name,
		wake = true,
	): TaskDelivery {
		return {
			id: JSON.stringify(['task-delivery', event, room, to ?? null]),
			room,
			from,
			text,
			task,
			sourceRoom,
			wake,
			...(to === undefined ? {} : { to }),
		};
	}

	private author(activation: string, readThrough: number | undefined): string {
		const state = this.host.state();
		const spec = activationSpec(activation, state);
		const lease = state.leases.get(activation);
		if (this.cancelling() !== undefined) throw new Error('The owning exchange is being cancelled.');
		if (
			this.host.gone() ||
			spec?.purpose.kind !== 'respond' ||
			lease === undefined ||
			!state.roster.some((seat) => seat.name === spec.seat) ||
			!isLive(lease, this.host.now())
		)
			throw new Error('The Task activation is stale.');
		if (!Number.isSafeInteger(readThrough) || readThrough !== state.lastSeq)
			throw new TaskConflict('The room changed. Read the new context before deciding again.');
		return spec.seat;
	}

	private requireTask(id: string): TaskView {
		const task = this.host.state().tasks?.get(id);
		if (task === undefined) throw new Error(`Unknown Task '${id}'.`);
		return task;
	}
	private open(task: TaskView): void {
		if (!taskTransitionAllowed(task.status))
			throw new TaskConflict(`Task '${task.id}' is already ${task.status}.`, task);
	}
	private text(value: string): string {
		if (!value.trim()) throw new Error('Task text cannot be empty.');
		return value.trim();
	}

	private async answer(
		activation: string,
		action: () => Promise<TaskOperationResult>,
	): Promise<TaskResponse> {
		try {
			const result = await action();
			return this.withContext(activation, result);
		} catch (error) {
			if (!(error instanceof TaskConflict)) throw error;
			return this.withContext(activation, {
				refused: error.message,
				...(error.task === undefined ? {} : { task: error.task }),
			});
		}
	}
	private async withContext(
		activation: string,
		result: TaskOperationResult,
	): Promise<TaskResponse> {
		const response = await this.host.view(activation);
		const facts =
			'refused' in result && result.task !== undefined
				? { ...result, task: taskContext(result.task, this.host.name) }
				: result;
		return structuredClone({ ...facts, ...('view' in response ? { view: response.view } : {}) });
	}

	pending(): TaskDelivery[] {
		const changes = this.changes();
		const completed = new Set(
			changes.flatMap((change) => (change.type === 'delivered' ? [change.delivery] : [])),
		);
		return changes
			.flatMap((change) => ('deliveries' in change ? change.deliveries : []))
			.filter((delivery) => !completed.has(delivery.id));
	}

	active(exchange: number): boolean {
		if (this.cancelling()?.exchange === exchange) return true;
		const tasks = this.tasks().filter(
			(task) => task.originRoom === this.host.name && task.exchange === exchange,
		);
		if (tasks.some((task) => task.status === 'open')) return true;
		if (
			this.changes().some(
				(change) =>
					change.type === 'operation' &&
					tasks.some((task) => task.id === change.operation.task) &&
					this.recorded(`${change.operation.id}:result`) === undefined,
			)
		)
			return true;
		if (this.pending().some((delivery) => delivery.task.exchange === exchange)) return true;
		return [...new Set(tasks.map((task) => task.workingRoom))].some((room) => {
			const child = this.host.get(room);
			return child === undefined || child.busy();
		});
	}

	busy(): boolean {
		if (!liveWork(this.host.state(), this.host.now()).rest || this.pending().length > 0)
			return true;
		return this.changes().some(
			(change) =>
				change.type === 'operation' && this.recorded(`${change.operation.id}:result`) === undefined,
		);
	}

	async restore(): Promise<void> {
		for (const task of this.tasks()) {
			if (task.originRoom === this.host.name && task.exchange === this.host.state().exchange?.from)
				await this.host.ensure(task);
		}
	}

	drain(): Promise<void> {
		this.draining ??= this.drainOnce().finally(() => {
			this.draining = undefined;
		});
		return this.draining;
	}
	private async drainOnce(): Promise<void> {
		await this.restore();
		const cancellation = this.cancelling();
		if (cancellation !== undefined) {
			await this.finishCancellation(cancellation);
			return;
		}
		for (const change of this.changes()) {
			if (
				change.type === 'operation' &&
				this.recorded(`${change.operation.id}:result`) === undefined
			)
				await this.forward(change.operation);
		}
		for (const delivery of this.pending()) await this.send(delivery);
		await this.intervene();
	}

	private async intervene(): Promise<void> {
		for (const task of this.tasks()) {
			if (task.originRoom !== this.host.name || task.status !== 'open') continue;
			const child = this.host.get(task.workingRoom);
			if (child === undefined) continue;
			const decision = this.idleDecision(task, child);
			if (decision === undefined) continue;
			const key = JSON.stringify(['task-runtime', task.id, decision]);
			await this.host
				.write(key, () => {
					const current = this.requireTask(task.id);
					const latest = this.idleDecision(current, child);
					if (JSON.stringify(latest) !== JSON.stringify(decision))
						throw new TaskConflict('The Task activity changed.');
					const base = {
						event: key,
						task: task.id,
						sourceRoom: task.workingRoom,
						at: at(this.host),
						deliveries: [],
					};
					const change: TaskEventChange =
						decision.kind === 'idle'
							? { ...base, type: 'idle', epoch: decision.epoch }
							: {
									...base,
									type: 'updated',
									status: 'failed',
									text: decision.reason,
									outcome: decision.reason,
								};
					return {
						...change,
						deliveries: this.eventDeliveries(changedTask(current, change), change),
					};
				})
				.catch((error: unknown) => {
					if (!(error instanceof TaskConflict)) throw error;
				});
		}
	}

	private idleDecision(task: TaskView, child: TaskHost) {
		return taskIdleDecision({
			origin: this.host.state(),
			task,
			working: child.host.state(),
			now: this.host.now(),
			pendingDelivery:
				this.pending().some((delivery) => delivery.task.id === task.id) || child.unresolved(),
		});
	}

	private unresolved(): boolean {
		return this.changes().some(
			(change) =>
				change.type === 'operation' && this.recorded(`${change.operation.id}:result`) === undefined,
		);
	}
	private async send(delivery: TaskDelivery): Promise<void> {
		const target =
			delivery.room === delivery.task.workingRoom
				? await this.host.ensure(delivery.task)
				: this.host.get(delivery.room);
		if (target === undefined) throw new Error('The Task delivery destination is unavailable.');
		const seq = await target.host.deliver(delivery);
		const event = `${delivery.id}:ack`;
		await this.host.write(event, () => ({
			type: 'delivered',
			event,
			delivery: delivery.id,
			seq,
			...(seq === 0 ? { failure: 'The subscription recipient is no longer seated.' } : {}),
			at: at(this.host),
		}));
		this.host.changed();
	}

	private cancelling(): Extract<TaskChange, { type: 'cancelling' }> | undefined {
		return this.changes().find(
			(change): change is Extract<TaskChange, { type: 'cancelling' }> =>
				change.type === 'cancelling' && change.exchange === this.host.state().exchange?.from,
		);
	}

	async cancel(key: string): Promise<boolean> {
		const exchange = this.host.state().exchange?.from;
		if (
			exchange === undefined ||
			!this.tasks().some((task) => task.originRoom === this.host.name && task.exchange === exchange)
		)
			return false;
		const event = `${key}:tasks`;
		const change = await this.host.write(event, () => ({
			type: 'cancelling',
			event,
			exchange,
			at: at(this.host),
		}));
		if (change.type !== 'cancelling') throw new Error('Invalid Task cancellation.');
		await this.drain();
		if (this.cancelling() !== undefined) await this.drain();
		return true;
	}

	private async finishCancellation(
		change: Extract<TaskChange, { type: 'cancelling' }>,
	): Promise<void> {
		const tasks = this.tasks().filter(
			(task) => task.originRoom === this.host.name && task.exchange === change.exchange,
		);
		for (const delivery of this.pending())
			if (delivery.task.status === 'open') await this.cancelDelivery(delivery);
		for (const task of tasks) await this.cancelTask(task, change.event);
		for (const recorded of this.changes()) {
			if (
				recorded.type === 'operation' &&
				this.recorded(`${recorded.operation.id}:result`) === undefined
			)
				await this.forward(recorded.operation);
		}
		for (const delivery of this.pending()) await this.send(delivery);
		for (const room of new Set(tasks.map((task) => task.workingRoom))) {
			const child = this.host.get(room);
			await child?.host.stop();
			await child?.drain();
		}
		await this.host.cancel(`${change.event}:closed`);
	}

	private async cancelDelivery(delivery: TaskDelivery): Promise<void> {
		const event = `${delivery.id}:ack`;
		await this.host.write(event, () => ({
			type: 'delivered',
			event,
			delivery: delivery.id,
			seq: 0,
			failure: 'The owning exchange was cancelled.',
			at: at(this.host),
		}));
	}

	private async cancelTask(task: TaskView, cancellation: string): Promise<void> {
		if (task.status !== 'open') return;
		const event = `${cancellation}:${task.id}`;
		await this.host
			.write(event, () => {
				const current = this.requireTask(task.id);
				if (current.status !== 'open')
					throw new TaskConflict('The Task already finished.', current);
				const reason = 'The owning exchange was cancelled.';
				const change: Extract<TaskEventChange, { type: 'updated' }> = {
					type: 'updated',
					event,
					task: task.id,
					text: reason,
					outcome: reason,
					status: 'failed',
					sourceRoom: this.host.name,
					at: at(this.host),
					deliveries: [],
				};
				return {
					...change,
					deliveries: this.eventDeliveries(changedTask(current, change), change).map(
						(delivery) => ({ ...delivery, wake: false }),
					),
				};
			})
			.catch((error: unknown) => {
				if (!(error instanceof TaskConflict)) throw error;
			});
	}
}
