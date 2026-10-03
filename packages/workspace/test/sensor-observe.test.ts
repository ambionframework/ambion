import { describe, expect, it } from 'vitest';
import { callTool, quiet } from '../../ambion/test/support/scripted.ts';
import { DEFAULT_AUDIT_LOG } from '../src/audit.ts';
import type { ObjectBackend } from '../src/object-backend.ts';
import { toolOf } from './support/backends.ts';
import { composed } from './support/compose.ts';
import { agent, run, toolResults } from './support/room.ts';
import { sensorFixture } from './support/sensor-fixture.ts';
import {
	fileBytes,
	fileDigest,
	frameBytes,
	frameDigest,
	openSensorObserveRoom,
} from './support/sensor-observe-room.ts';

const span = { from: '2026-09-29T10:00:00.000Z', to: '2026-09-29T10:00:03.000Z' };

async function textAt(
	site: Awaited<ReturnType<typeof openSensorObserveRoom>>['site'],
	agent: string,
	path: string,
) {
	return site.use({ name: agent }, async (env) => {
		const result = await env.readTextFile(path);
		if (!result.ok) throw result.error;
		return result.value;
	});
}

describe('workspace observe integration', () => {
	it('works on the first direct call, reads latest and supported spans, binds through compose, and retains every part', async () => {
		const rig = await openSensorObserveRoom();
		try {
			// Calling the actual bound tool directly has no reminder or discovery text in its context.
			const latest = await rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			expect(typeof latest).not.toBe('string');
			if (typeof latest === 'string')
				throw new Error('observe returned a string instead of content.');
			const latestText = latest.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			expect(latestText).toContain('Observation 1 at 2026-09-29T09:59:59.000Z');
			expect(latestText).toContain('Observation 2 at 2026-09-29T10:00:01.000Z');
			expect(latestText).toContain('Series voltage: 5, 5.01, 5.02 V');
			expect(latestText).toContain('Sensor data: Supply stable at 5 V.');
			expect(latestText).toContain('Frame at 2026-09-29T10:00:01.000Z:');
			expect(latestText).toContain('File reading.csv (text/csv):');
			expect(latestText).toContain('Snapshot ref: ambion://workspace/');
			const latestImages = latest.content.filter((part) => part.type === 'image');
			expect(latestImages).toHaveLength(1);
			const latestImage = latestImages[0];
			if (latestImage === undefined) throw new Error('The observation has no frame image.');
			expect(Buffer.from(latestImage.data, 'base64')).toEqual(Buffer.from(frameBytes));
			expect((latest.details as { request: unknown }).request).toEqual({ api: 1 });
			expect((latest.details as { source: { dirty: boolean } }).source.dirty).toBe(false);

			const windowed = await rig.observe.invoke({ sensor: 'bench-one/bench', span }, rig.observer);
			if (typeof windowed === 'string')
				throw new Error('observe returned a string instead of content.');
			expect((windowed.details as { request: unknown }).request).toEqual({ api: 1, span });
			const windowText = windowed.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			expect(windowText).toContain('Observation 1 at 2026-09-29T10:00:01.000Z');
			expect(windowText).not.toContain('Observation 1 at 2026-09-29T09:59:59.000Z');
			expect(rig.observeCalls).toBe(2);

			// The same two tools through compose, with their declared details.
			const result = await composed(
				rig.site.tools(),
				['connect', 'observe'],
				`const connected = await tools.connect({ name: 'bench-one', process: '${rig.process}', port: ${rig.port} });
const observed = await tools.observe({ sensor: 'bench-one/bench' });
return { connected, observed };`,
				'sensor-owner',
			);
			expect(result.status).toBe('completed');
			const { connected, observed } = result.value as Record<
				'connected' | 'observed',
				Record<string, unknown>
			>;
			expect(connected).toMatchObject({
				name: 'bench-one',
				process: rig.process,
				port: rig.port,
				owner: 'sensor-owner',
				sensors: ['bench-one/bench'],
			});
			expect(connected).not.toHaveProperty('index');
			expect(observed).toMatchObject({
				sensor: 'bench-one/bench',
				request: { api: 1 },
				manifestRef: expect.stringContaining('ambion://workspace/'),
				manifestPath: expect.any(String),
				directory: expect.any(String),
			});
			expect((observed.files as unknown[]).length).toBeGreaterThan(0);
			expect(rig.observeCalls).toBe(3);
		} finally {
			await rig.close();
		}
	});

	it('runs observe in a real room, audits its request and refs, and accepts the manifest citation', async () => {
		const rig = await openSensorObserveRoom({ defect: 'dirty-source' });
		const startedAt = Date.now();
		let hasImage = false;
		let manifestRef: string | undefined;
		try {
			const room = await run([agent('observer', { bundles: [rig.site.tools()] })], {
				observer: (context, _who, _call) => {
					const results = toolResults(context);
					const observed = results.find((result) => result.tool === 'observe');
					if (observed === undefined) return callTool('observe', { sensor: 'bench-one/bench' });
					const ref = /Snapshot ref: (ambion:\/\/\S+)/.exec(observed.text)?.[1];
					if (ref === undefined)
						throw new Error('The observe result did not name its manifest ref.');
					manifestRef = ref;
					const response = context.messages.find(
						(message) => message.role === 'toolResult' && message.toolName === 'observe',
					);
					hasImage =
						response?.role === 'toolResult' &&
						Array.isArray(response.content) &&
						response.content.some((part) => part.type === 'image');
					if (!results.some((result) => result.tool === 'say'))
						return callTool('say', { text: 'The bench observation is retained.', refs: [ref] });
					return quiet();
				},
			});
			const citedManifestRef = manifestRef;
			if (citedManifestRef === undefined) throw new Error('The observation has no manifest ref.');
			expect(citedManifestRef).toMatch(/^ambion:\/\/workspace\//);
			expect(hasImage).toBe(true);
			const messages = (await room.read()).messages;
			expect(
				messages.some(
					(message) => message.kind === 'said' && message.refs?.includes(citedManifestRef),
				),
			).toBe(true);

			const auditText = await textAt(rig.site, 'observer', DEFAULT_AUDIT_LOG);
			const finishedAt = Date.now();
			const entries = auditText
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const connect = entries.find((entry) => entry.tool === 'connect');
			const observe = entries.find((entry) => entry.tool === 'observe');
			expect(connect).toMatchObject({
				agent: 'sensor-owner',
				arguments: { name: 'bench-one', port: rig.port },
				result: {
					details: { owner: 'sensor-owner', process: rig.process, sensors: ['bench-one/bench'] },
				},
			});
			expect(observe).toMatchObject({
				agent: 'observer',
				room: expect.any(String),
				arguments: { sensor: 'bench-one/bench' },
				result: {
					details: {
						sensor: 'bench-one/bench',
						request: { api: 1 },
						source: { dirty: true },
						connection: { name: 'bench-one', owner: 'sensor-owner', port: rig.port },
						manifestRef: citedManifestRef,
					},
				},
			});
			expect(Date.parse(observe?.time as string)).toBeGreaterThanOrEqual(startedAt);
			expect(Date.parse(observe?.time as string)).toBeLessThanOrEqual(finishedAt);
			expect(rig.observeCalls).toBe(1);
		} finally {
			await rig.close();
		}
	});

	it('restores the manifest and exact frame and file bytes after the server stops for another agent', async () => {
		const rig = await openSensorObserveRoom({ defect: 'dirty-source' });
		try {
			const observed = await rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			if (typeof observed === 'string')
				throw new Error('observe returned a string instead of content.');
			const details = observed.details as {
				manifestRef: string;
				manifestPath: string;
				files: readonly { digest: string; ref: string; path: string }[];
			};
			expect(details.files.map((file) => file.digest).sort()).toEqual(
				[fileDigest, frameDigest].sort(),
			);
			await rig.stopServer();

			const bundle = rig.site.tools();
			const restore = bundle.tools.find((tool) => tool.name === 'restore');
			if (restore === undefined) throw new Error('The workspace has no restore tool.');
			const manifest = await restore.invoke(
				{ ref: details.manifestRef },
				rig.observerFor('reviewer'),
			);
			if (typeof manifest === 'string')
				throw new Error('restore returned a string instead of details.');
			const manifestPath = (manifest.details as { path: string }).path;
			const manifestBody = JSON.parse(await textAt(rig.site, 'reviewer', manifestPath)) as {
				observations: unknown;
				source: { dirty: boolean };
				files: readonly { digest: string; ref: string }[];
			};
			// The retained wire payload, including source timestamps and series boundaries, stays exact.
			expect(manifestBody.observations).toEqual(sensorFixture.sensors[0]?.latest);
			expect(manifestBody.source.dirty).toBe(true);
			for (const item of manifestBody.files) {
				const restored = await restore.invoke({ ref: item.ref }, rig.observerFor('reviewer'));
				if (typeof restored === 'string')
					throw new Error('restore returned a string instead of details.');
				const path = (restored.details as { path: string }).path;
				const bytes = await rig.site.use({ name: 'reviewer' }, async (env) => {
					const result = await env.readBinaryFile(path);
					if (!result.ok) throw result.error;
					return result.value;
				});
				expect(Buffer.from(bytes)).toEqual(
					Buffer.from(item.digest === frameDigest ? frameBytes : fileBytes),
				);
			}
		} finally {
			await rig.close();
		}
	});

	it('keeps observe inputs fixed and names the path of each image beside the image part', async () => {
		const rig = await openSensorObserveRoom();
		try {
			const observeSchema = rig.observe.parameters as {
				properties: Record<string, unknown>;
				additionalProperties?: boolean;
			};
			expect(Object.keys(observeSchema.properties).sort()).toEqual(['sensor', 'span']);
			expect(observeSchema.additionalProperties).toBe(false);

			const observed = await rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			if (typeof observed === 'string')
				throw new Error('observe returned a string instead of content.');
			expect(observed.content.filter((part) => part.type === 'image')).toHaveLength(1);
			const output = observed.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			expect(output).toContain('Frame at 2026-09-29T10:00:01.000Z:');

			const pngPath = '/home/observer/example.png';
			await rig.site.use({ name: 'observer' }, async (env) => {
				const result = await env.writeFile(pngPath, frameBytes);
				if (!result.ok) throw result.error;
			});
			const read = rig.site.tools().tools.find((tool) => tool.name === 'read');
			if (read === undefined) throw new Error('The workspace has no read tool.');
			const result = await read.invoke({ path: pngPath }, rig.observer);
			if (typeof result === 'string') throw new Error('read returned a string instead of content.');
			expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
			const readText = result.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			expect(readText).toContain(`Image path: ${pngPath}`);

			// A format with no image part, such as BMP, still names the path of the file.
			const bmpPath = '/home/observer/example.bmp';
			await rig.site.use({ name: 'observer' }, async (env) => {
				const result = await env.writeFile(bmpPath, onePixelBmp());
				if (!result.ok) throw result.error;
			});
			const bmp = await read.invoke({ path: bmpPath }, rig.observer);
			if (typeof bmp === 'string') throw new Error('read returned a string instead of content.');
			expect(bmp.content.filter((part) => part.type === 'image')).toEqual([]);
			expect(JSON.stringify(bmp.content)).toContain(`Image path: ${bmpPath}`);
		} finally {
			await rig.close();
		}
	});

	it('rejects unsupported spans and unavailable connections explicitly', async () => {
		const unsupported = await openSensorObserveRoom({ defect: 'unsupported-span' });
		try {
			await expect(
				unsupported.observe.invoke({ sensor: 'bench-one/bench', span }, unsupported.observer),
			).rejects.toThrow(/does not support span reads/i);
			expect(unsupported.observeCalls).toBe(0);
			await unsupported.site.processes.cancel(unsupported.process);
			await expect(
				unsupported.observe.invoke({ sensor: 'bench-one/bench' }, unsupported.observer),
			).rejects.toThrow(/unknown or unavailable/i);
		} finally {
			await unsupported.close();
		}

		const unavailable = await openSensorObserveRoom({ defect: 'unavailable-span' });
		try {
			await expect(
				unavailable.observe.invoke({ sensor: 'bench-one/bench', span }, unavailable.observer),
			).rejects.toThrow(/requested span/i);
			expect(unavailable.observeCalls).toBe(1);
		} finally {
			await unavailable.close();
		}
	});

	it('keeps the shell usable while an HTTP observation is pending', async () => {
		let enterRequest!: () => void;
		let releaseRequest!: () => void;
		const entered = new Promise<void>((resolve) => (enterRequest = resolve));
		const gate = new Promise<void>((resolve) => (releaseRequest = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeObserve() {
					enterRequest();
					await gate;
				},
			},
		});
		try {
			const observation = rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			await entered;
			let writeFinished = false;
			const write = rig.site.use({ name: 'observer' }, async (env) => {
				const result = await env.writeFile('/home/observer/while-observe.txt', 'ready');
				if (!result.ok) throw result.error;
				writeFinished = true;
			});
			const completedBeforeResponse = await Promise.race([
				write.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			expect(completedBeforeResponse).toBe(true);
			expect(writeFinished).toBe(true);
			releaseRequest();
			await Promise.all([observation, write]);
			expect(rig.observeCalls).toBe(1);
		} finally {
			releaseRequest();
			await rig.close();
		}
	});

	it('refuses an observation when its process ends before the response is verified', async () => {
		let enterRequest!: () => void;
		let releaseRequest!: () => void;
		const entered = new Promise<void>((resolve) => (enterRequest = resolve));
		const gate = new Promise<void>((resolve) => (releaseRequest = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeObserve() {
					enterRequest();
					await gate;
				},
			},
		});
		try {
			const observation = rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			await entered;
			await rig.site.processes.cancel(rig.process);
			releaseRequest();
			await expect(observation).rejects.toThrow(/ended or its connection changed before/i);
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			releaseRequest();
			await rig.close();
		}
	});

	it('refuses an observation when its process ends during a blocked file fetch', async () => {
		let enterFile!: () => void;
		let releaseFile!: () => void;
		const entered = new Promise<void>((resolve) => (enterFile = resolve));
		const gate = new Promise<void>((resolve) => (releaseFile = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeFile() {
					enterFile();
					await gate;
				},
			},
		});
		try {
			const observation = rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			await entered;
			await rig.site.processes.cancel(rig.process);
			releaseFile();
			await expect(observation).rejects.toThrow(/ended or its connection changed before/i);
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			releaseFile();
			await rig.close();
		}
	});

	it('refuses an observation when its connection is replaced while the request is in flight', async () => {
		let enterRequest!: () => void;
		let releaseRequest!: () => void;
		const entered = new Promise<void>((resolve) => (enterRequest = resolve));
		const gate = new Promise<void>((resolve) => (releaseRequest = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeObserve() {
					enterRequest();
					await gate;
				},
			},
		});
		try {
			const observation = rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer);
			await entered;
			await rig.site.processes.cancel(rig.process);
			const started = await toolOf(rig.site, 'bash').invoke(
				{ command: 'sleep 30', wait: 0 },
				rig.owner,
			);
			if (typeof started === 'string') throw new Error('The bash tool did not return details.');
			const replacement = (started.details as { process: { handle: string } }).process.handle;
			await toolOf(rig.site, 'connect').invoke(
				{ name: 'bench-one', process: replacement, port: rig.port },
				rig.owner,
			);
			releaseRequest();
			await expect(observation).rejects.toThrow(/ended or its connection changed before/i);
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			releaseRequest();
			await rig.close();
		}
	});

	it('propagates cancellation without replay or partially retained exports', async () => {
		let enterRequest!: () => void;
		let releaseRequest!: () => void;
		const entered = new Promise<void>((resolve) => (enterRequest = resolve));
		const gate = new Promise<void>((resolve) => (releaseRequest = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeObserve() {
					enterRequest();
					await gate;
				},
			},
		});
		const controller = new AbortController();
		try {
			const operation = rig.observe.invoke(
				{ sensor: 'bench-one/bench' },
				{ ...rig.observer, signal: controller.signal },
			);
			await entered;
			controller.abort(new Error('stop observation'));
			await expect(operation).rejects.toThrow(/stop observation|abort/i);
			releaseRequest();
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			releaseRequest();
			await rig.close();
		}
	});

	it('propagates cancellation during file fetch without retention or replay', async () => {
		let enterFile!: () => void;
		let releaseFile!: () => void;
		const entered = new Promise<void>((resolve) => (enterFile = resolve));
		const gate = new Promise<void>((resolve) => (releaseFile = resolve));
		const rig = await openSensorObserveRoom({
			server: {
				async beforeFile() {
					enterFile();
					await gate;
				},
			},
		});
		const controller = new AbortController();
		try {
			const operation = rig.observe.invoke(
				{ sensor: 'bench-one/bench' },
				{ ...rig.observer, signal: controller.signal },
			);
			await entered;
			controller.abort(new Error('stop file fetch'));
			await expect(operation).rejects.toThrow(/stop file fetch|abort/i);
			releaseFile();
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			releaseFile();
			await rig.close();
		}
	});

	it('reports retention failure and does not replay the server observation', async () => {
		const objects: ObjectBackend = {
			label: 'fixture-refuses-writes',
			async connect() {
				return {
					async put() {
						throw new Error('fixture object store refused the write');
					},
					async get() {
						return undefined;
					},
					async cleanup() {},
				};
			},
		};
		const rig = await openSensorObserveRoom({ objects });
		try {
			await expect(rig.observe.invoke({ sensor: 'bench-one/bench' }, rig.observer)).rejects.toThrow(
				/fixture object store refused/i,
			);
			expect(rig.observeCalls).toBe(1);
			const exports = await rig.site.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations'),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			await rig.close();
		}
	});
});

/** A BMP file of one pixel: the 14-byte file header, the 40-byte info header, and one padded row. */
function onePixelBmp(): Uint8Array {
	const bytes = new Uint8Array(58);
	const view = new DataView(bytes.buffer);
	bytes.set([0x42, 0x4d]);
	view.setUint32(2, 58, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, 1, true);
	view.setInt32(22, 1, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	view.setUint32(34, 4, true);
	bytes.set([0, 0, 255, 0], 54);
	return bytes;
}
