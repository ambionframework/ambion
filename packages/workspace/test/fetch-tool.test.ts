import { createHash } from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Process } from '../src/process-files.ts';
import type { Workspace } from '../src/workspace.ts';
import { callAs, toolOf } from './support/backends.ts';
import { composed } from './support/compose.ts';
import { httpWorkspace, mapped, type Reply, type Routes, serve } from './support/http-fixture.ts';

const MiB = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string): string =>
	createHash('sha256').update(bytes).digest('hex');

/** A PNG of one pixel, with a real header. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);

/** A workspace, and a process named `camera` of `ada` with a server on its port. */
async function rig(
	routes: Routes | ((started: { workspace: Workspace; process: Process }) => Routes) = {},
	name = 'camera',
) {
	const { workspace } = httpWorkspace();
	onTestFinished(() => workspace.dispose());
	const { process, port } = await mapped(workspace, 'ada', name);
	const server = await serve(
		typeof routes === 'function' ? routes({ workspace, process }) : routes,
		port,
	);
	onTestFinished(() => server.close());
	return { workspace, process, port, server };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Call `fetch` as `bob`, a second agent, and give the text, the parts, and the details. */
async function call(workspace: Rig['workspace'], params: unknown) {
	const result = await toolOf(workspace, 'fetch').invoke(params, callAs('bob'));
	if (typeof result === 'string') throw new Error('fetch gives a structured result.');
	return {
		text: result.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
		images: result.content.filter((part) => part.type === 'image'),
		details: result.details as Record<string, unknown>,
	};
}

const failed = (workspace: Rig['workspace'], params: unknown): Promise<string> =>
	call(workspace, params).then(
		() => 'The call did not fail.',
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

/** The bytes of a file of bob. */
const fileOf = (workspace: Rig['workspace'], path: string) =>
	workspace.use({ name: 'bob' }, async (env) => {
		const read = await env.readBinaryFile(path);
		if (!read.ok) throw read.error;
		return Buffer.from(read.value);
	});

describe('fetch', () => {
	it.each<{
		name: string;
		reply: Reply;
		mediaType: string;
		extension: string;
		shown?: string;
		field?: 'json' | 'text';
		image?: boolean;
	}>([
		{
			name: 'JSON',
			reply: { body: '{"api":2,"ok":true}', type: 'application/json; charset=utf-8' },
			mediaType: 'application/json',
			extension: 'json',
			shown: '{"api":2,"ok":true}',
			field: 'json',
		},
		{
			name: 'a JSON variant',
			reply: { body: '{"a":1}', type: 'Application/Vnd.Api+JSON' },
			mediaType: 'application/vnd.api+json',
			extension: 'json',
			shown: '{"a":1}',
			field: 'json',
		},
		{
			name: 'text',
			reply: { body: 'line one\nline two', type: 'text/plain' },
			mediaType: 'text/plain',
			extension: 'txt',
			shown: 'line one\nline two',
			field: 'text',
		},
		{
			name: 'CSV',
			reply: { body: 'a,b\n1,2\n', type: 'text/csv' },
			mediaType: 'text/csv',
			extension: 'csv',
			shown: 'a,b\n1,2\n',
			field: 'text',
		},
		{
			name: 'a PNG image',
			reply: { body: PNG, type: 'image/png' },
			mediaType: 'image/png',
			extension: 'png',
			image: true,
		},
		{
			name: 'a body with a type that no rule names',
			reply: { body: new Uint8Array([1, 2, 3, 0, 255]), type: 'application/x-frame' },
			mediaType: 'application/x-frame',
			extension: 'bin',
		},
		{
			name: 'a body with no content type',
			reply: { body: new Uint8Array([9, 8, 7]) },
			mediaType: 'application/octet-stream',
			extension: 'bin',
		},
		{
			name: 'an image whose bytes do not match its type',
			reply: { body: 'not an image', type: 'image/png' },
			mediaType: 'image/png',
			extension: 'png',
		},
		{
			name: 'JSON that does not parse',
			reply: { body: '{"broken":', type: 'application/json' },
			mediaType: 'application/json',
			extension: 'json',
			shown: '{"broken":',
			field: 'text',
		},
		{
			name: 'JSON past the inline limit',
			reply: { body: `[${'1,'.repeat(2 * MiB)}0]`, type: 'application/json' },
			mediaType: 'application/json',
			extension: 'json',
		},
	])(
		'reads $name, keeps the body as a snapshot and as a file of the caller, and renders it',
		async ({ reply, mediaType, extension, shown, field, image }) => {
			const { workspace, process, server } = await rig({ '/read?x=1': reply });
			const body = Buffer.from(reply.body);
			const { text, images, details } = await call(workspace, {
				process: 'camera',
				path: '/read?x=1',
			});
			const digest = sha256(body);
			const file = `/home/bob/.fetch/camera/${digest.slice(0, 12)}.${extension}`;
			const ref = `ambion://workspace/${workspace.name}/snapshot/${digest}${file}`;
			expect(server.requests).toEqual(['/read?x=1']);
			const large = shown === undefined && body.byteLength > 4 * MiB;
			const lines = [
				`Fetched /read?x=1 from camera (${process.handle}): 200, ${mediaType}, ${body.byteLength} bytes.`,
				...(shown === undefined ? [] : [`Process data: ${shown}`]),
				...(large
					? [`The body is larger than 4 MiB, so it is not shown. The full body is at ${file}.`]
					: []),
				`File: ${file}`,
				`Snapshot ref: ${ref}`,
			];
			expect(text).toBe(lines.join('\n'));
			expect(details).toEqual({
				process: 'camera',
				handle: process.handle,
				owner: 'ada',
				path: '/read?x=1',
				status: 200,
				mediaType,
				bytes: body.byteLength,
				sha256: digest,
				ref,
				file,
				...(field === 'json' && shown !== undefined ? { json: JSON.parse(shown) } : {}),
				...(field === 'text' && shown !== undefined ? { text: shown } : {}),
			});
			expect(images).toEqual(
				image ? [{ type: 'image', data: body.toString('base64'), mimeType: mediaType }] : [],
			);
			// The file of the caller, and the snapshot through restore, hold the received bytes.
			expect(sha256(await fileOf(workspace, file))).toBe(digest);
			const restored = await toolOf(workspace, 'restore').invoke(
				{ ref, path: '/home/bob/restored' },
				callAs('bob'),
			);
			expect(typeof restored).not.toBe('string');
			expect(sha256(await fileOf(workspace, '/home/bob/restored'))).toBe(digest);
		},
	);

	it('cuts a long body in the text, keeps it whole in the file, and says where the file is', async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n');
		const { workspace } = await rig({ '/log': { body: lines, type: 'text/plain' } });
		const { text, details } = await call(workspace, { process: 'camera', path: '/log' });
		expect(text).toContain('row 0\n');
		expect(text).not.toContain('row 2999');
		expect(text).toContain(`The full body is at ${details.file}.`);
		expect(details.text).toBe(lines);
		expect((await fileOf(workspace, String(details.file))).toString()).toBe(lines);
	});

	it('writes the same file again for the same bytes, so an edit lasts until the next read', async () => {
		const { workspace } = await rig({ '/a': { body: 'same', type: 'text/plain' } });
		const first = await call(workspace, { process: 'camera', path: '/a' });
		const file = String(first.details.file);
		await workspace.use({ name: 'bob' }, (env) => env.writeFile(file, 'edited'));
		expect((await fileOf(workspace, file)).toString()).toBe('edited');
		const second = await call(workspace, { process: 'camera', path: '/a' });
		expect(second.details.file).toBe(file);
		expect((await fileOf(workspace, file)).toString()).toBe('same');
	});

	it('reads a process by handle, and a process of the caller that has no name', async () => {
		const { workspace, process } = await rig({ '/': { body: 'hi', type: 'text/plain' } });
		const byHandle = await call(workspace, { process: process.handle, path: '/' });
		expect(byHandle.details).toMatchObject({ process: 'camera', handle: process.handle });
		const unnamed = await toolOf(workspace, 'bash').invoke(
			{ command: 'sleep 300', wait: 0 },
			callAs('ada'),
		);
		if (typeof unnamed === 'string') throw new Error('bash gives a structured result.');
		const { process: loose } = unnamed.details as { process: { handle: string; port: number } };
		const server = await serve({ '/': { body: 'loose', type: 'text/plain' } }, loose.port);
		onTestFinished(() => server.close());
		const read = await call(workspace, { process: loose.handle, path: '/' });
		expect(read.details).toMatchObject({ process: loose.handle, handle: loose.handle });
		expect(read.text).toContain(`from ${loose.handle} (${loose.handle})`);
	});

	it.each([
		{
			name: 'an unknown name',
			params: { process: 'lathe', path: '/' },
			error:
				"No running process is named 'lathe'. A process of an agent that has not acted since the host started is not listed yet.",
		},
		{
			name: 'a status outside 200 to 299, with the start of the body',
			params: { process: 'camera', path: '/missing' },
			error: "Process 'camera' answered 404 for /missing. Process data: not here",
		},
		{
			name: 'a failure with a long body, cut at 2 KiB',
			params: { process: 'camera', path: '/boom' },
			error: `Process 'camera' answered 500 for /boom. Process data: ${'x'.repeat(2048)}`,
		},
		{
			name: 'a redirect answer',
			params: { process: 'camera', path: '/moved' },
			error: "Process 'camera' answered a redirect for /moved. fetch does not follow redirects.",
		},
		{
			name: 'a path that the schema refuses',
			params: { process: 'camera', path: 'no-slash' },
			error: /^Invalid arguments for tool 'fetch'/,
		},
		{
			name: 'a path with a fragment',
			params: { process: 'camera', path: '/a#b' },
			error: /^Invalid arguments for tool 'fetch'/,
		},
		{
			name: 'a field that the schema does not name',
			params: { process: 'camera', path: '/', method: 'POST' },
			error: /^Invalid arguments for tool 'fetch'/,
		},
	])('fails for $name and keeps nothing', async ({ params, error }) => {
		const { workspace } = await rig({
			'/boom': { status: 500, body: 'x'.repeat(5000) },
			'/moved': { status: 302, body: '', location: '/boom' },
		});
		const message = await failed(workspace, params);
		if (typeof error === 'string') expect(message).toBe(error);
		else expect(message).toMatch(error);
		expect(await workspace.use({ name: 'bob' }, (env) => env.exists('/home/bob/.fetch'))).toEqual({
			ok: true,
			value: false,
		});
	});

	it('fails for two running processes with one name, and reads each by its handle', async () => {
		const { workspace, process } = await rig({ '/': { body: 'ada', type: 'text/plain' } });
		const other = await mapped(workspace, 'cy', 'camera');
		const server = await serve({ '/': { body: 'cy', type: 'text/plain' } }, other.port);
		onTestFinished(() => server.close());
		expect(await failed(workspace, { process: 'camera', path: '/' })).toBe(
			`Two running processes are named 'camera': ${process.handle} of ada, ${other.process.handle} of cy. Give the handle.`,
		);
		const first = await call(workspace, { process: process.handle, path: '/' });
		const second = await call(workspace, { process: other.process.handle, path: '/' });
		expect([first.details.owner, second.details.owner]).toEqual(['ada', 'cy']);
		expect(second.text).toContain('Process data: cy');
	});

	it('fails for a process that does not listen on its port, and for a process that has ended', async () => {
		const { workspace, process, server } = await rig();
		await server.close();
		expect(await failed(workspace, { process: 'camera', path: '/' })).toBe(
			`Process 'camera' (${process.handle}) does not listen on $PORT ${process.port}.`,
		);
		await workspace.processes.cancel(process.handle);
		expect(await failed(workspace, { process: 'camera', path: '/' })).toMatch(
			/^No running process is named 'camera'\./,
		);
	});

	it.each([
		{
			name: 'a refused forwarding',
			error: Object.assign(new Error('SSH port forwarding was refused'), { code: 'ECONNREFUSED' }),
			message: (process: Process) =>
				`Process 'camera' (${process.handle}) does not listen on $PORT ${process.port}.`,
		},
		{
			name: 'a forward that fails for another cause',
			error: new Error('The session closed.'),
			message: (process: Process) =>
				`The read of /a from 'camera' (${process.handle}) failed: The session closed.`,
		},
	])('says $name as the endpoints give it', async ({ error, message }) => {
		const { workspace } = httpWorkspace([error]);
		onTestFinished(() => workspace.dispose());
		const { process } = await mapped(workspace, 'ada', 'camera');
		expect(await failed(workspace, { process: 'camera', path: '/a' })).toBe(message(process));
	});

	it('fails for a body past 64 MiB, and keeps nothing', async () => {
		const { workspace } = await rig({
			'/big': { body: new Uint8Array(64 * MiB + 1), type: 'application/octet-stream' },
		});
		expect(await failed(workspace, { process: 'camera', path: '/big' })).toBe(
			'The body of /big is larger than 64 MiB. Nothing was kept.',
		);
		expect(await workspace.use({ name: 'bob' }, (env) => env.exists('/home/bob/.fetch'))).toEqual({
			ok: true,
			value: false,
		});
	});

	it('fails when the process ends during the read, and keeps nothing', async () => {
		const { workspace, process } = await rig(({ workspace, process }) => ({
			'/slow': {
				body: 'late',
				type: 'text/plain',
				before: async () => void (await workspace.processes.cancel(process.handle)),
			},
		}));
		expect(await failed(workspace, { process: 'camera', path: '/slow' })).toBe(
			`Process 'camera' (${process.handle}) ended during the read. Nothing was kept.`,
		);
		expect(await workspace.use({ name: 'bob' }, (env) => env.exists('/home/bob/.fetch'))).toEqual({
			ok: true,
			value: false,
		});
	});

	it('closes the forward of a process at dispose', async () => {
		const { workspace, forwards } = httpWorkspace();
		const { port } = await mapped(workspace, 'ada', 'camera');
		const server = await serve({ '/': { body: 'up', type: 'text/plain' } }, port);
		onTestFinished(() => server.close());
		await call(workspace, { process: 'camera', path: '/' });
		expect(forwards).toEqual([{ agent: 'ada', port, closed: false }]);
		await workspace.dispose();
		expect(forwards.map((forward) => forward.closed)).toEqual([true]);
	});

	it('gives the host a request with any method and no retention, and reads the declared output through compose', async () => {
		const { workspace, process, server } = await rig({
			'/': { body: '{"n":1}', type: 'application/json' },
		});
		const host = workspace.fetch;
		if (host === undefined) throw new Error('The workspace has no fetch.');
		const response = await host('camera', '/', { method: 'POST', headers: { 'x-test': '1' } });
		expect(await response.json()).toEqual({ n: 1 });
		expect(server.requests).toEqual(['/']);
		await expect(host('lathe', '/')).rejects.toThrow("No running process is named 'lathe'");
		expect((await host(process.handle, '/')).status).toBe(200);
		const result = await composed(
			workspace.tools(),
			['fetch'],
			`return await tools.fetch({ process: 'camera', path: '/' });`,
			'bob',
		);
		expect(result.status).toBe('completed');
		expect(result.value).toMatchObject({ handle: process.handle, status: 200, json: { n: 1 } });
	});
});
