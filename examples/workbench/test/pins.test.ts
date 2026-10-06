import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { readFile, readPins } from '../src/files.ts';
import { plain } from '../src/pins.ts';
import { openHost, respondingStream } from './hosting.ts';

const call = (name: string, args: Record<string, string | Record<string, string>>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const quiet = () => fauxAssistantMessage('quiet', { stopReason: 'stop' });

/** The assistant pins the kit file at its first activation, and hides it at its second. */
function pinning() {
	const steps = [
		call('show', {
			name: 'kit',
			kind: 'markdown',
			source: { type: 'file', path: '/shared/kit.md' },
			title: 'The kit',
		}),
		quiet(),
		call('hide', { name: 'kit' }),
		quiet(),
	];
	return respondingStream((agent, _request, closing) => {
		if (closing) return call('say', { text: 'Summary: pinned.' });
		return agent === 'assistant' ? (steps.shift() ?? quiet()) : quiet();
	});
}

describe('Workbench pins', () => {
	it('lists a file that an agent shows, reads it as the author, and drops it on hide', async () => {
		const workbench = await openHost({ stream: pinning() });
		expect(await workbench.pins('bringup')).toEqual([]);
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'k1', 'Pin the kit file.');

		await vi.waitFor(async () => expect(await workbench.pins('bringup')).toHaveLength(1), {
			timeout: 10_000,
			interval: 20,
		});
		const [pin] = await workbench.pins('bringup');
		expect(pin).toMatchObject({
			name: 'kit',
			title: 'The kit',
			kind: 'markdown',
			author: 'assistant',
			path: '/shared/kit.md',
		});
		expect(pin?.file?.text).toContain('# The kit');
		expect(await workbench.pins('power')).toEqual([]);

		await vi.waitFor(
			async () => expect((await workbench.read('bringup', 0)).exchange).toBeUndefined(),
			{
				timeout: 10_000,
				interval: 20,
			},
		);
		await workbench.send('bringup', 'mira', 'k2', 'Hide the kit file.');
		await vi.waitFor(async () => expect(await workbench.pins('bringup')).toEqual([]), {
			timeout: 10_000,
			interval: 20,
		});
	}, 30_000);
});

describe('readPins', () => {
	const widget = (name: string, kind: string, path: string, author = 'scribe') => ({
		room: 'bringup',
		name,
		revision: name,
		rev: 1,
		state: 'shown' as const,
		kind,
		source: { type: 'file' as const, path },
		author,
	});

	it('reads each file as its author, and gives a failed read or a wrong kind as a problem', async () => {
		const site = openWorkspace({ name: 'pins', backend: { bash: memoryBackend() } });
		await site.use({ name: 'scribe' }, async (env) => {
			await env.writeFile(
				'/notes.md',
				'# Notes\n\u001b[31mred\u001b[0m \u001b]0;title\u0007text\n',
			);
			await env.writeFile('/big.md', 'x'.repeat(131_073));
		});

		const pins = await readPins(site, [
			widget('notes', 'markdown', '/notes.md'),
			widget('big', 'markdown', '/big.md'),
			widget('missing', 'markdown', '/missing.md'),
			widget('wrong', 'image', '/notes.md'),
			{ ...widget('hidden', 'markdown', '/notes.md'), state: 'hidden' as never },
			widget('other', 'frame', '/notes.md'),
		]);

		expect(pins.map((pin) => pin.name)).toEqual(['notes', 'big', 'missing', 'wrong']);
		expect(pins[0]?.file?.text).toBe('# Notes\nred text\n');
		expect(pins[1]?.problem).toMatch(/128 KiB/);
		expect(pins[2]?.problem).toBe('File not found.');
		expect(pins[3]?.problem).toBe('This file is not a picture.');
		await site.dispose();
	});

	it('refuses a symbolic path, and reads as the agent that the caller names', async () => {
		const site = openWorkspace({ name: 'pins-agent', backend: { bash: memoryBackend() } });
		await site.use({ name: 'scribe' }, (env) => env.writeFile('/a.md', 'a'));
		await expect(readFile(site, '/a/../a.md', { name: 'scribe' })).rejects.toThrow(
			'Use an absolute workspace file path.',
		);
		expect((await readFile(site, '/a.md', { name: 'scribe' })).text).toBe('a');
		await site.dispose();
	});
});

describe('plain', () => {
	it('drops escape sequences and control characters and keeps newlines, tabs, and text', () => {
		expect(plain('a\u001b[1;31mb\u001b[0m\tc\nd\u0000e\u0007f\u001b]8;;x\u001b\\g\u009bh')).toBe(
			'ab\tc\ndefgh',
		);
	});
});
