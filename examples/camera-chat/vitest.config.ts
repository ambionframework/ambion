import { defineConfig } from 'vitest/config';

// OpenTUI loads its native renderer through Node FFI. A test worker needs the
// flag itself, because a worker does not inherit the flags of the vitest process.
export default defineConfig({
	test: {
		execArgv: ['--experimental-ffi'],
	},
});
