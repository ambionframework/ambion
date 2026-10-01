/**
 * `registerRepositories`: every decision of repository registration, over a
 * plain in-memory `RegistrationSteps` that records each call. The backends
 * test their own storage steps, and the git conformance runs these
 * decisions once through each backend.
 */
import { describe, expect, it } from 'vitest';
import { type RegistrationSteps, registerRepositories } from '../src/git-registration.ts';
import type { RepositoryRegistration } from '../src/git-templates.ts';
import { hashesOf, type SourceFiles } from '../src/sources.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const BLANK: SourceFiles = { 'README.md': bytes('blank\n') };

/** The state of the fake storage before the registration. */
interface Stored {
	readonly templates?: Readonly<Record<string, SourceFiles>>;
	readonly shared?: readonly string[];
	/** Whether a write publishes its repository. The default is yes. */
	readonly lands?: boolean;
	/** The error that `updateTemplate` throws. */
	readonly refuses?: string;
	/** Whether another host process landed the source before the refusal. */
	readonly landedFirst?: boolean;
}

/** Steps over a map and a set. Each call pushes a line to `calls`. */
function fake(stored: Stored = {}) {
	const calls: string[] = [];
	const templates = new Map(
		Object.entries(stored.templates ?? {}).map(([name, files]) => [name, hashesOf(files)]),
	);
	const shared = new Set(stored.shared);
	const lands = stored.lands ?? true;
	const label = (verb: string, name: string, description: string | undefined) =>
		`${verb} ${name}${description === undefined ? '' : ` (${description})`}`;
	const steps: RegistrationSteps = {
		template: async (name, description) => {
			calls.push(label('template', name, description));
			return templates.get(name);
		},
		createTemplate: async (name, files, description) => {
			calls.push(label('create', name, description));
			if (lands) templates.set(name, hashesOf(files));
		},
		updateTemplate: async (name, files, description) => {
			calls.push(label('update', name, description));
			if (stored.refuses !== undefined) {
				if (stored.landedFirst === true) templates.set(name, hashesOf(files));
				throw new Error(stored.refuses);
			}
			if (lands) templates.set(name, hashesOf(files));
		},
		shared: async (name, description) => {
			calls.push(label('shared', name, description));
			return shared.has(name);
		},
		seedShared: async (name, _files, description) => {
			calls.push(label('seed', name, description));
			if (lands) shared.add(name);
		},
	};
	return { steps, calls };
}

const blank = (description?: string): RepositoryRegistration => ({
	source: { 'README.md': 'blank\n' },
	...(description === undefined ? {} : { description }),
});

/** A source whose read fails the test. */
const unreadable: RepositoryRegistration = {
	source: {
		read: async () => {
			throw new Error('The source was read.');
		},
	},
};

describe('registerRepositories', () => {
	it.each<[string, Stored, Parameters<typeof registerRepositories>[1], readonly string[]]>([
		[
			'creates a new template, and reads it again',
			{},
			{ templates: { blank: blank('A start.') } },
			['template blank (A start.)', 'create blank (A start.)', 'template blank (A start.)'],
		],
		[
			'writes nothing for a template that holds its source',
			{ templates: { blank: BLANK } },
			{ templates: { blank: blank() } },
			['template blank'],
		],
		[
			'updates a template that holds other files, and reads it again',
			{ templates: { blank: { 'OLD.md': bytes('old\n') } } },
			{ templates: { blank: blank() } },
			['template blank', 'update blank', 'template blank'],
		],
		[
			'leaves a published shared repository, and reads no source',
			{ shared: ['notes'] },
			{ shared: { notes: { ...unreadable, description: 'Notes.' } } },
			['shared notes (Notes.)'],
		],
		[
			'seeds a new shared repository once, and reads it again',
			{},
			{ shared: { notes: blank('Notes.') } },
			['shared notes (Notes.)', 'seed notes (Notes.)', 'shared notes (Notes.)'],
		],
		[
			'registers templates, then shared repositories, each in name order',
			{ shared: ['c'] },
			{
				shared: { d: blank(), c: blank() },
				templates: { b: blank(), a: blank() },
			},
			[
				...['a', 'b'].flatMap((name) => [`template ${name}`, `create ${name}`, `template ${name}`]),
				'shared c',
				...['shared d', 'seed d', 'shared d'],
			],
		],
		['registers nothing for no registrations', {}, {}, []],
	])('%s', async (_name, stored, repositories, expected) => {
		const { steps, calls } = fake(stored);
		await registerRepositories(steps, repositories);
		expect(calls).toEqual(expected);
	});

	describe.each<['template' | 'shared repository', 'templates' | 'shared', readonly string[]]>([
		['template', 'templates', []],
		['shared repository', 'shared', ['shared bad']],
	])('a %s', (kind, key, before) => {
		it('refuses an invalid name before it reads the source', async () => {
			const { steps, calls } = fake();
			await expect(
				registerRepositories(steps, { [key]: { 'Weekly Report': unreadable } }),
			).rejects.toMatchObject({ message: `'Weekly Report' is not a valid ${kind} name.` });
			expect(calls).toEqual([]);
		});

		it.each(['../x', '.git/config', 'a/../b', 'a/./b', 'a//b', '/abs', 'dir/.git/hooks/x'])(
			'refuses the path %j, and writes nothing',
			async (path) => {
				const { steps, calls } = fake();
				await expect(
					registerRepositories(steps, { [key]: { bad: { source: { [path]: 'y' } } } }),
				).rejects.toMatchObject({
					message: `The ${kind} 'bad' holds the path '${path}', which leaves its root.`,
				});
				expect(calls).toEqual(before);
			},
		);
	});

	it.each<[string, Stored, Parameters<typeof registerRepositories>[1], string]>([
		[
			'a template that is not published after its creation',
			{ lands: false },
			{ templates: { blank: blank() } },
			"The template 'blank' is missing after its registration.",
		],
		[
			'a template that does not hold its source after its update',
			{ lands: false, templates: { blank: { 'OLD.md': bytes('old\n') } } },
			{ templates: { blank: blank() } },
			"The template 'blank' does not hold its source after its registration.",
		],
		[
			'a shared repository that is not published after its seed',
			{ lands: false },
			{ shared: { notes: blank() } },
			"The shared repository 'notes' is missing after its registration.",
		],
	])('refuses %s', async (_name, stored, repositories, message) => {
		const { steps } = fake(stored);
		await expect(registerRepositories(steps, repositories)).rejects.toMatchObject({ message });
	});

	it.each<[string, boolean, readonly string[], string | undefined]>([
		[
			'succeeds when the tip holds the source after a refused update',
			true,
			['template blank', 'update blank', 'template blank', 'template blank'],
			undefined,
		],
		[
			'passes the cause of a refused update when the tip differs',
			false,
			['template blank', 'update blank', 'template blank'],
			'The template did not move.',
		],
	])('%s', async (_name, landedFirst, expected, cause) => {
		const { steps, calls } = fake({
			refuses: 'The template did not move.',
			landedFirst,
			templates: { blank: { 'OLD.md': bytes('old\n') } },
		});
		const registered = registerRepositories(steps, { templates: { blank: blank() } });
		if (cause === undefined) await registered;
		else await expect(registered).rejects.toMatchObject({ message: cause });
		expect(calls).toEqual(expected);
	});
});
