import type { ToolBundle } from '@ambionframework/ambion';
import type { SqlResource, Workspace } from '@ambionframework/workspace';
import { describe, expect, it, vi } from 'vitest';
import { team } from '../src/definitions.ts';
import type { Instrument } from '../src/instrument.ts';

const bundle = (): ToolBundle => ({ tools: [] });

describe('the team', () => {
	it('gives every agent the workspace, database, and instrument tools', () => {
		const workspace = { tools: vi.fn(bundle) } as unknown as Workspace;
		const lab = { tools: vi.fn(bundle) } as unknown as SqlResource;
		const instrument = { tools: vi.fn(bundle) } as unknown as Instrument;
		const built = team(workspace, lab, instrument);
		expect(built.agents).toHaveLength(4);
		expect(workspace.tools).toHaveBeenCalledTimes(built.agents.length);
		expect(lab.tools).toHaveBeenCalledTimes(built.agents.length);
		expect(instrument.tools).toHaveBeenCalledTimes(built.agents.length);
	});
});
