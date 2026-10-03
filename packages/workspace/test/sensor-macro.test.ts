/**
 * The `observe` macro of the sensor-server template, run through compose
 * over a real workspace. The template's own server answers a latest read.
 * A test server on the port of a process answers a span, an index at
 * another API version, and a file with the wrong digest.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fromDirectory, loadSkills } from '../src/index.ts';
import type { Workspace } from '../src/workspace.ts';
import { composed } from './support/compose.ts';
import { httpWorkspace, mapped, type Routes, serve } from './support/http-fixture.ts';

const template = fileURLToPath(
	new URL('../../../examples/workbench/templates/sensor-server/', import.meta.url),
);
const sha256 = (bytes: Uint8Array | string): string =>
	createHash('sha256').update(bytes).digest('hex');

const SOURCE = {
	repository: 'agent/sensors',
	commit: 'a'.repeat(40),
	dirty: false,
};
const SPAN = { from: '2025-01-02T03:04:00.000Z', to: '2025-01-02T03:05:00.000Z' };
const json = (body: unknown) => ({ body: JSON.stringify(body), type: 'application/json' });

/** A workspace, and the macro as the template ships it. */
async function rig() {
	const { workspace } = httpWorkspace();
	onTestFinished(() => workspace.dispose());
	const skills = await loadSkills(fromDirectory(join(template, 'skills')));
	const macro = skills.macros.find((one) => one.name === 'sensor-server/observe');
	if (macro === undefined) throw new Error('The template has no observe macro.');
	return { workspace, macro };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Run the macro as `bob` with `args`, and give its value. */
async function observe({ workspace, macro }: Rig, args: Record<string, string>) {
	const result = await composed(
		workspace.tools(),
		[...macro.uses],
		`return await (async (args) => {\n${macro.code}\n})(${JSON.stringify(args)});`,
		'bob',
	);
	return result.value as Record<string, unknown>;
}

const failed = (rigged: Rig, args: Record<string, string>): Promise<string> =>
	observe(rigged, args).then(
		() => 'The macro did not finish with an error.',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

/** A test server for the process `name` of `ada`. */
async function served(workspace: Workspace, name: string, routes: Routes) {
	const { port } = await mapped(workspace, 'ada', name);
	const server = await serve(routes, port);
	onTestFinished(() => server.close());
}

/** Run the template server on the port of the process `name` of `ada`. */
async function templateServer(workspace: Workspace, name: string) {
	const { port } = await mapped(workspace, 'ada', name);
	const data = await mkdtemp(join(tmpdir(), 'ambion-sensor-macro-'));
	const child: ChildProcess = spawn(process.execPath, [join(template, 'server.mjs')], {
		cwd: template,
		env: {
			...process.env,
			AMBION_SENSOR_DATA_DIR: data,
			AMBION_SENSOR_REPOSITORY: 'agent/sensors',
			PORT: String(port),
		},
		stdio: 'ignore',
	});
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	onTestFinished(async () => {
		child.kill('SIGTERM');
		await exited;
		await rm(data, { recursive: true, force: true });
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		const answered = await fetch(`http://127.0.0.1:${port}/`).then(
			(response) => response.ok,
			() => false,
		);
		if (answered) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('The template server did not listen.');
}

describe('the observe macro of the sensor-server template', () => {
	it('reads the latest observation and the files that it names from the real server', async () => {
		const rigged = await rig();
		await templateServer(rigged.workspace, 'bench');
		const frame = await readFile(join(template, 'fixtures', 'frame.png'));
		const digest = sha256(frame);
		const notes = await observe(rigged, { process: 'bench', sensor: 'operator-notes' });
		expect(notes).toMatchObject({
			source: { repository: SOURCE.repository, dirty: expect.any(Boolean) },
			observations: 1,
			times: ['2025-01-02T03:04:07.000Z'],
			files: [],
		});
		expect(notes.refs).toHaveLength(1);
		const camera = await observe(rigged, { process: 'bench', sensor: 'bench-camera' });
		expect(camera.times).toEqual(['2025-01-02T03:04:06.000Z']);
		expect(camera.files).toEqual([
			{
				digest,
				path: expect.stringMatching(new RegExp(`/\\.fetch/bench/${digest.slice(0, 12)}\\.png$`)),
				ref: expect.any(String),
			},
		]);
		expect(camera.refs).toHaveLength(2);
		const read = await rigged.workspace.use({ name: 'bob' }, async (env) => {
			const file = (camera.files as { path: string }[])[0]?.path ?? '';
			const bytes = await env.readBinaryFile(file);
			if (!bytes.ok) throw bytes.error;
			return Buffer.from(bytes.value);
		});
		expect(read.equals(frame)).toBe(true);
	});

	it('sends a span in the query, and refuses a span that the real server does not support', async () => {
		const rigged = await rig();
		const observation = { at: '2025-01-02T03:04:30.000Z', parts: [{ kind: 'text', text: 'hi' }] };
		await served(rigged.workspace, 'spanner', {
			'/': json({ api: 2, source: SOURCE, sensors: [] }),
			[`/clock/observe?from=${encodeURIComponent(SPAN.from)}&to=${encodeURIComponent(SPAN.to)}`]:
				json({ api: 2, observations: [observation] }),
		});
		const spanned = await observe(rigged, { process: 'spanner', sensor: 'clock', ...SPAN });
		expect(spanned).toMatchObject({ observations: 1, times: [observation.at], source: SOURCE });
		await templateServer(rigged.workspace, 'bench');
		expect(await failed(rigged, { process: 'bench', sensor: 'operator-notes', ...SPAN })).toContain(
			'answered 422',
		);
	});

	it('refuses a server at another API version', async () => {
		const rigged = await rig();
		await served(rigged.workspace, 'old', { '/': json({ api: 1, source: SOURCE, sensors: [] }) });
		expect(await failed(rigged, { process: 'old', sensor: 'clock' })).toContain(
			'old serves sensor API 1; this macro reads API 2.',
		);
	});

	it('refuses a file whose bytes do not match its digest', async () => {
		const rigged = await rig();
		const digest = sha256('the bytes that the observation names');
		await served(rigged.workspace, 'liar', {
			'/': json({ api: 2, source: SOURCE, sensors: [] }),
			'/clock/observe': json({
				api: 2,
				observations: [
					{
						at: '2025-01-02T03:04:30.000Z',
						parts: [{ kind: 'frame', file: digest, mediaType: 'image/png' }],
					},
				],
			}),
			[`/files/${digest}`]: { body: 'other bytes', type: 'image/png' },
		});
		const other = sha256('other bytes');
		expect(await failed(rigged, { process: 'liar', sensor: 'clock' })).toContain(
			`File ${digest} arrived as ${other}.`,
		);
	});
});
