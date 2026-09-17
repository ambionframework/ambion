import { describe, expect, it } from 'vitest';
import { backends } from './support/backends.ts';

describe.each(backends)('$name root traversal', (fixture) => {
	it('finds shared artifacts from the virtual root', async () => {
		const { backend, dispose } = await fixture.open();
		try {
			const env = await backend.connect({ name: 'reviewer', identity: 'Reviewer' });
			expect((await env.createDir('/shared')).ok).toBe(true);
			expect((await env.writeFile('/shared/prototype.html', '<h1>Relay</h1>')).ok).toBe(true);
			expect(await env.fileInfo('/')).toMatchObject({ ok: true, value: { kind: 'directory' } });
			expect(await env.exec('find / -iname "prototype.html"')).toMatchObject({
				ok: true,
				value: { stdout: '/shared/prototype.html\n', stderr: '', exitCode: 0 },
			});
		} finally {
			await dispose();
		}
	});
});
