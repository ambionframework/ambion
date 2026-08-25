/** @type {import('prettier').Config} */
export default {
	printWidth: 100,
	semi: true,
	singleQuote: true,
	tabWidth: 2,
	trailingComma: 'all',
	useTabs: true,
	overrides: [
		{
			files: ['.*', '*.md', '*.yml', '*.yaml', '*.toml'],
			options: {
				useTabs: false,
			},
		},
		{
			files: ['**/pnpm-lock.yaml'],
			options: {
				requirePragma: true,
			},
		},
		{
			files: ['**/*.jsonc'],
			options: {
				trailingComma: 'none',
			},
		},
	],
};
