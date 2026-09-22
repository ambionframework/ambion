/**
 * The SQL resource and a just-bash workspace are two independent bindings of
 * the one resource contract, and this is the one scenario that needs both:
 * every other SQL resource scenario lives in `packages/workspace/test/sql-resource.test.ts`,
 * over `:memory:` alone.
 */

import { openSqlResource, openWorkspace, type WorkspaceResource } from '@ambionframework/workspace';
import { expect, it } from 'vitest';
import { memoryBackend } from '../src/index.ts';

it('is a second resource on the one contract beside a workspace', async () => {
	const drive = openWorkspace({ name: 'drive', backend: memoryBackend() });
	const sql = openSqlResource({ name: 'lab', location: ':memory:' });
	try {
		const resources: WorkspaceResource[] = [drive, sql];
		expect(resources.map((resource) => resource.name)).toEqual(['drive', 'lab']);
		expect(sql.tools().tools.map((tool) => tool.name)).toEqual(['query', 'record']);
		expect(drive.tools().tools.map((tool) => tool.name)).not.toContain('query');
	} finally {
		await drive.dispose();
		await sql.dispose();
	}
});
