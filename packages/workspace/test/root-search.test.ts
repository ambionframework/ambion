import { BACKGROUND_CONTEXT } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { backends } from './support/backends.ts';

describe.each(backends)('$name root traversal', (fixture) => {
	it('finds shared artifacts from the virtual root', async () => {
		const { backend, dispose } = await fixture.open();
		const ctx = BACKGROUND_CONTEXT;
		try {
			const env = await backend.connect({ name: 'reviewer' });
			expect((await env.createDir('/shared', undefined, ctx)).ok).toBe(true);
			expect((await env.writeFile('/shared/prototype.html', '<h1>Relay</h1>', ctx)).ok).toBe(true);
			expect(await env.fileInfo('/', ctx)).toMatchObject({
				ok: true,
				value: { kind: 'directory' },
			});
			let output = '';
			const result = await env.exec(
				'find / -iname "prototype.html"',
				{
					capture: { limits: { maxBytes: 1_000_000, maxLines: 100_000 } },
					onUpdate: (update) => {
						if (update.kind === 'replace') output = update.output.text;
					},
				},
				ctx,
			);
			expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
			expect(output).toBe('/shared/prototype.html\n');
		} finally {
			await dispose();
		}
	});
});
