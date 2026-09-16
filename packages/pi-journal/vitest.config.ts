import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
