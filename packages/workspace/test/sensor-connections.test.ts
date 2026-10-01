import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSensorConnections } from '../src/sensor-connections.ts';
import {
	type ConnectionRig,
	connectionRig,
	index,
	source,
	status,
} from './support/sensor-connections.ts';

describe('the sensor connection registry', () => {
	let rig: ConnectionRig;
	let registry: ReturnType<typeof createSensorConnections>;
	beforeEach(async () => {
		rig = await connectionRig();
		registry = createSensorConnections(rig.endpoints, rig.processes);
	});
	afterEach(async () => {
		await registry.close();
		await rig.close();
	});

	const connect = (
		name = 'bench',
		process = rig.status.handle,
		agent = rig.status.agent,
		port = 43127,
	) => registry.connect({ name: agent }, { name, process, port });

	/**
	 * Make the process `handle` end during the next `skip + 1`th `find`, and let
	 * that `find` report `running`: a stale read that began before the end.
	 */
	const endDuringFind = (handle: string, skip = 0): void => {
		const original = rig.processes.find.bind(rig.processes);
		let seen = 0;
		(rig.processes as unknown as { find: typeof original }).find = async (...args) => {
			const found = await original(...args);
			if (seen++ === skip) {
				rig.end(handle);
				rig.setStatus(found);
			}
			return found;
		};
	};

	const running = (handle: string) => {
		const one = status(handle, 'owner', 'running');
		rig.setStatus(one);
		return one;
	};

	it('registers the validated index with immutable launch source and qualified names readable by any agent', async () => {
		const connection = await connect();
		expect(connection).toMatchObject({
			name: 'bench',
			owner: 'owner',
			port: 43127,
			hostname: 'fixture-workstation',
			source,
			index,
			available: true,
		});
		expect(Object.isFrozen(connection.source)).toBe(true);
		expect(Object.isFrozen(connection.index.sensors)).toBe(true);
		expect(await registry.get('bench/bench')).toBe(connection);
		expect(await registry.get('reader/bench')).toBeUndefined();
		expect(await registry.get('bench/no-such-sensor')).toBeUndefined();
	});

	it('lists captured names through the process table and marks ended connections unavailable', async () => {
		await connect('bench-one');
		await connect('bench-two', rig.status.handle, 'owner', 43128);
		expect(rig.indexRequests).toHaveLength(2);
		rig.failFind(new Error('temporary process table failure'));
		const uncertain = await registry.list();
		expect(uncertain.map((one) => one.state).sort()).toEqual(['connected', 'unknown']);
		expect(rig.indexRequests).toHaveLength(2);
		expect((await registry.list()).every((one) => one.state === 'connected')).toBe(true);
		rig.end();
		const ended = await registry.list();
		expect(ended.map((one) => one.state)).toEqual(['unavailable', 'unavailable']);
		expect(ended.map((one) => one.sensors[0]?.name)).toEqual(['bench', 'bench']);
		expect(rig.indexRequests).toHaveLength(2);
	});

	it.each([
		['wire version', { ...index, api: 2 }],
		['invalid source', { ...index, source: { ...source, commit: 'short' } }],
		['duplicate names', { ...index, sensors: [index.sensors[0], index.sensors[0]] }],
		['invalid sensor name', { ...index, sensors: [{ ...index.sensors[0], name: 'Bench' }] }],
	] as const)(
		'rejects a server index with %s and closes its temporary transport',
		async (_case, bad) => {
			rig.setIndex(bad);
			await expect(connect()).rejects.toThrow();
			expect(rig.opens).toHaveLength(1);
			expect(rig.opens[0]?.closed).toBe(1);
			expect(await registry.get('bench/bench')).toBeUndefined();
		},
	);

	it('rejects malformed connection names and ports before opening a transport', async () => {
		for (const name of ['Bench', '2bench', 'bench/name', 'bench\n'])
			await expect(connect(name)).rejects.toThrow(/name/i);
		for (const port of [0, 65_536, 1.5])
			await expect(connect('bench', rig.status.handle, 'owner', port)).rejects.toThrow(/port/i);
		expect(rig.opens).toHaveLength(0);
	});

	it('refreshes discovery on equal retries, preserves launch source, and closes the previous transport', async () => {
		const first = await connect();
		expect(rig.indexRequests).toHaveLength(1);
		const firstClient = first.client;
		rig.setIndex({
			...index,
			sensors: [{ name: 'pressure', description: 'Updated discovery.', spans: true }],
		});
		const retry = await connect();
		expect(rig.indexRequests).toHaveLength(2);
		expect(retry).toBe(first);
		expect(retry.source).toEqual(source);
		expect(retry.index.sensors).toEqual([
			{ name: 'pressure', description: 'Updated discovery.', spans: true },
		]);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1, 0]);
		expect(retry.client).not.toBe(firstClient);
		expect(await registry.get('bench/pressure')).toBe(first);
		expect(rig.indexRequests).toHaveLength(2);
	});

	it('rejects a changed launch source without replacing registration metadata or its transport', async () => {
		const connection = await connect();
		const client = connection.client;
		rig.setIndex({
			...index,
			source: { ...source, commit: 'c'.repeat(40), dirty: false },
			sensors: [{ name: 'pressure', description: 'Changed code.', spans: true }],
		});
		await expect(connect()).rejects.toThrow(/launch source changed/i);
		expect(connection.source).toEqual(source);
		expect(connection.source.dirty).toBe(true);
		expect(connection.index.sensors).toEqual(index.sensors);
		expect(connection.client).toBe(client);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([0, 1]);
		expect(await registry.get('bench/bench')).toBe(connection);
	});

	it('recovers an explicit retry after a transient process-table read failure', async () => {
		const connection = await connect();
		rig.failFind(new Error('temporary SSH status failure'));
		await expect(registry.get('bench/bench')).rejects.toThrow(/temporary SSH/);
		expect(connection.available).toBe(true);
		const priorClient = connection.client;
		const recovered = await connect();
		expect(recovered).toBe(connection);
		expect(recovered.client).not.toBe(priorClient);
		expect(recovered.available).toBe(true);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1, 0]);
	});

	it('allows one winner for concurrent claims and disposes the losing transport', async () => {
		const rival = status('bash-000000000002', 'rival', 'running');
		rig.setStatus(rival);
		const barrier = rig.blockIndex(2);
		const attempts = [
			connect('bench'),
			registry.connect(
				{ name: 'rival' },
				{
					name: 'bench',
					process: rival.handle,
					port: 43128,
				},
			),
		];
		await barrier.entered;
		barrier.release();
		const results = await Promise.allSettled(attempts);
		expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((one) => one.status === 'rejected')).toHaveLength(1);
		expect(rig.opens.map(({ closed }) => closed).sort()).toEqual([0, 1]);
	});

	it('rejects live conflicts and cross-owner attempts before opening another transport', async () => {
		await connect();
		const rival = status('bash-000000000002', 'rival', 'running');
		rig.setStatus(rival);
		await expect(
			registry.connect(
				{ name: 'rival' },
				{
					name: 'bench',
					process: rival.handle,
					port: 43128,
				},
			),
		).rejects.toThrow(/already assigned/i);
		await expect(connect('other', rig.status.handle, 'rival')).rejects.toThrow(/owned/i);
		expect(rig.opens).toHaveLength(1);
	});

	it('refuses stopped and mismatched-owner processes before readiness', async () => {
		(rig.processes as unknown as { find: () => Promise<unknown> }).find = async () =>
			status(rig.status.handle, 'rival', 'running');
		await expect(connect()).rejects.toThrow(/owner|identity/i);
		expect(rig.opens).toHaveLength(0);
		rig.setStatus(status(rig.status.handle, 'owner', 'exited'));
		(rig.processes as unknown as { find: () => Promise<unknown> }).find = async () =>
			status(rig.status.handle, 'owner', 'exited');
		await expect(connect()).rejects.toThrow(/running process/i);
		expect(rig.opens).toHaveLength(0);
	});

	it('rechecks after the HTTP handshake and leaves no registration when the process ended', async () => {
		const original = rig.processes.find.bind(rig.processes);
		let calls = 0;
		(rig.processes as unknown as { find: typeof original }).find = async (...args) => {
			calls += 1;
			if (calls === 2) rig.setStatus(status(rig.status.handle, 'owner', 'exited'));
			return original(...args);
		};
		await expect(connect()).rejects.toThrow(/running process/i);
		expect(rig.opens[0]?.closed).toBe(1);
		expect(await registry.get('bench/bench')).toBeUndefined();
		// The end event comes during the second read, which still reports `running`.
		const stale = running('bash-000000000012');
		endDuringFind(stale.handle, 1);
		await expect(connect('late', stale.handle)).rejects.toThrow(/has ended/);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1, 1]);
		expect(await registry.get('late/bench')).toBeUndefined();
	});

	it('keeps an ended handle unavailable after a later stale running read and never reuses its port', async () => {
		const connection = await connect();
		rig.end();
		expect(await registry.get('bench/bench')).toBeUndefined();
		expect(connection.available).toBe(false);
		rig.setStatus(rig.status);
		await expect(connect()).rejects.toThrow(/ended/i);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1]);
		// The process ends while the index request waits, and every read still reports `running`.
		const fetched = running('bash-000000000011');
		const gate = rig.blockIndex();
		const pending = connect('late', fetched.handle);
		await gate.entered;
		rig.end(fetched.handle);
		rig.setStatus(fetched);
		gate.release();
		await expect(pending).rejects.toThrow(/has ended/);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1, 1]);
		expect(await registry.get('late/bench')).toBeUndefined();
		// A read that began before the end marks the connection ended at once, in `get` and in `list`.
		const got = running('bash-000000000013');
		const gotConnection = await connect('got', got.handle);
		endDuringFind(got.handle);
		expect(await registry.get('got/bench')).toBeUndefined();
		expect(gotConnection.available).toBe(false);
		const listed = running('bash-000000000014');
		await connect('listed', listed.handle);
		endDuringFind(listed.handle);
		const states = await registry.list();
		expect(states.find((one) => one.name === 'listed')?.state).toBe('unavailable');
	});

	it('lets only the owner replace an ended registration', async () => {
		await connect();
		rig.setStatus(status(rig.status.handle, 'owner', 'exited'));
		const replacement = status('bash-000000000003', 'owner', 'running');
		rig.setStatus(replacement);
		await expect(
			registry.connect(
				{ name: 'rival' },
				{
					name: 'bench',
					process: replacement.handle,
					port: 43129,
				},
			),
		).rejects.toThrow(/Only 'owner'/);
		const next = await connect('bench', replacement.handle);
		expect(next.process.handle).toBe(replacement.handle);
		expect(next.owner).toBe('owner');
	});

	it('cancels failed readiness without stopping the process and isolates an aborted retry', async () => {
		const gate = rig.blockIndex();
		const controller = new AbortController();
		const pending = registry.connect(
			{ name: 'owner' },
			{
				name: 'bench',
				process: rig.status.handle,
				port: 43127,
			},
			controller.signal,
		);
		await gate.entered;
		controller.abort(new Error('cancel this connect'));
		await expect(pending).rejects.toThrow('cancel this connect');
		gate.release();
		expect(rig.opens[0]?.closed).toBe(1);
		expect((await rig.processes.find({ name: 'owner' }, rig.status.handle)).state).toBe('running');
		const first = await connect();
		const retryGate = rig.blockIndex();
		const retryController = new AbortController();
		const retry = registry.connect(
			{ name: 'owner' },
			{
				name: 'bench',
				process: rig.status.handle,
				port: 43127,
			},
			retryController.signal,
		);
		await retryGate.entered;
		retryController.abort(new Error('abort refresh'));
		await expect(retry).rejects.toThrow('abort refresh');
		retryGate.release();
		expect(await registry.get('bench/bench')).toBe(first);
		expect(rig.opens.map(({ closed }) => closed)).toEqual([1, 0, 1]);
	});

	it('disposal aborts readiness, closes transports, and rejects later claims', async () => {
		const gate = rig.blockIndex();
		const pending = connect();
		await gate.entered;
		const disposal = registry.close();
		await expect(pending).rejects.toThrow();
		await disposal;
		expect(rig.opens[0]?.closed).toBe(1);
		gate.release();
		await expect(connect()).rejects.toThrow(/closing/i);
	});

	it('does not wait for network readiness under a process resource operation', async () => {
		const gate = rig.blockIndex();
		const pending = connect();
		await gate.entered;
		// The table lookup is the only process operation; it completed before the held HTTP response.
		expect(rig.finds).toEqual(['owner/bash-000000000001']);
		gate.release();
		await pending;
	});
});
