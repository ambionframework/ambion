/**
 * The layers of `packages/ambion/src`, from the bottom layer up.
 *
 * `files` holds globs relative to `packages/ambion/src`. `imports` names the
 * other layers that this layer may import. A layer may always import its own
 * layer, and every pair that no entry lists is refused. `about` is the line
 * that the layer comment of `biome.jsonc` shows.
 *
 * `scripts/import-rules.test.mjs` derives one probe for each pair of layers
 * from this table, and checks that `biome.jsonc` refuses the same pairs.
 */
export const CORE_LAYERS = [
	{
		name: 'vocabulary',
		files: [
			'activation-id.ts',
			'bodies.ts',
			'bundle.ts',
			'define.ts',
			'errors.ts',
			'record.ts',
			'refs.ts',
			'scheduling.ts',
			'types.ts',
		],
		imports: [],
		about: 'the public shapes, the stored bodies, the record lines, and the identity codec',
	},
	{
		name: 'protocol',
		files: ['protocol.ts'],
		imports: ['vocabulary'],
		about: 'the wire shapes between the room and a seat',
	},
	{
		name: 'host',
		files: ['host/**'],
		// LB5 removes the import of the execution layer.
		imports: ['vocabulary', 'protocol', 'execution'],
		about: 'what a host owns: the runtime value',
	},
	{
		name: 'journal',
		files: ['journal/**'],
		imports: ['vocabulary'],
		about: "the room's kinds, over @ambionframework/journal",
	},
	{
		name: 'room',
		files: ['room/**'],
		imports: ['vocabulary', 'protocol', 'journal'],
		about: 'every fact and every decision, pure over the journal',
	},
	{
		name: 'answers',
		files: ['answers.ts'],
		imports: ['vocabulary', 'protocol', 'journal', 'room'],
		about: "what the room answers a seat's three calls with",
	},
	{
		name: 'execution',
		files: ['execution/**'],
		imports: ['vocabulary', 'protocol', 'host'],
		about: 'the execution side of the wire: driver, contract, rendering',
	},
	{
		name: 'conformance',
		files: ['conformance*.ts'],
		imports: ['vocabulary', 'protocol', 'host', 'execution'],
		about: 'the suites that play the room from outside the wire',
	},
	{
		name: 'testing',
		files: ['testing/**'],
		imports: ['vocabulary', 'protocol', 'host', 'execution'],
		about: 'the deterministic test tools, over the vocabulary and the execution contract',
	},
	{
		name: 'room-host',
		files: ['room-host/**'],
		imports: ['vocabulary', 'protocol', 'host', 'journal', 'room', 'answers'],
		about: 'room.ts (state, phases), core.ts (shared view), one file per mechanism',
	},
	{
		name: 'facade',
		files: ['room.ts'],
		imports: [
			'vocabulary',
			'protocol',
			'host',
			'journal',
			'room',
			'answers',
			'execution',
			'room-host',
		],
		about: 'the room facade, which composes the layers below it',
	},
	{
		name: 'entries',
		files: ['index.ts', 'hosting.ts', 'testing.ts'],
		imports: [
			'vocabulary',
			'protocol',
			'host',
			'journal',
			'room',
			'answers',
			'execution',
			'conformance',
			'testing',
			'room-host',
			'facade',
		],
		about: 'the published entry files, which reach every layer',
	},
];
