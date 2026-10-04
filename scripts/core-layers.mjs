/**
 * The layers of `packages/ambion/src`, from the bottom layer up.
 *
 * `files` holds globs relative to `packages/ambion/src`. `exclude` holds the
 * files of those globs that belong to another layer. `imports` names the
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
			'compose-catalog.ts',
			'compose-describe.ts',
			'compose-macros.ts',
			'compose-run.ts',
			'compose-tool.ts',
			'compose.ts',
			'define.ts',
			'errors.ts',
			'record.ts',
			'refs.ts',
			'scheduling.ts',
			'session-facts.ts',
			'single-flight.ts',
			'tool-call.ts',
			'types.ts',
		],
		imports: [],
		about:
			'the public shapes, the stored bodies, the record lines, the session facts, and the identity codec',
	},
	{
		name: 'protocol',
		files: ['protocol.ts'],
		imports: ['vocabulary'],
		about: 'the wire shapes between the room and a seat',
	},
	{
		name: 'contract',
		files: ['execution/contract.ts'],
		imports: ['vocabulary', 'protocol'],
		about: 'the executor contract: the types between the driver and one running activation',
	},
	{
		name: 'host',
		files: ['host/**'],
		imports: ['vocabulary', 'protocol', 'contract'],
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
		exclude: ['execution/contract.ts'],
		imports: ['vocabulary', 'protocol', 'contract', 'host'],
		about: 'the execution side of the wire: driver, rendering, tool bodies, trace',
	},
	{
		name: 'conformance',
		files: ['conformance*.ts'],
		imports: ['vocabulary', 'protocol', 'contract', 'host', 'execution'],
		about: 'the suites that play the room from outside the wire',
	},
	{
		name: 'testing',
		files: ['testing/**'],
		imports: ['vocabulary', 'protocol', 'contract', 'host', 'execution'],
		about: 'the deterministic test tools, over the vocabulary and the execution side',
	},
	{
		name: 'room-run',
		files: ['room-run/**'],
		imports: ['vocabulary', 'protocol', 'host', 'journal', 'room', 'answers'],
		about: 'room.ts (state, phases), core.ts (shared view, no sibling), one file per mechanism',
	},
	{
		name: 'facade',
		files: ['room.ts'],
		imports: [
			'vocabulary',
			'protocol',
			'contract',
			'host',
			'journal',
			'room',
			'answers',
			'execution',
			'room-run',
		],
		about: 'the room facade, which composes the layers below it',
	},
	{
		name: 'entries',
		files: ['index.ts', 'hosting.ts', 'testing.ts'],
		imports: [
			'vocabulary',
			'protocol',
			'contract',
			'host',
			'journal',
			'room',
			'answers',
			'execution',
			'conformance',
			'testing',
			'room-run',
			'facade',
		],
		about: 'the published entry files, which reach every layer',
	},
];
