import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
	// The core is a dependency, and the bundle imports it. `tsconfig.check.json`
	// points the specifier at the core's source for the type-checker alone.
	external: ['@ambionframework/ambion'],
});
