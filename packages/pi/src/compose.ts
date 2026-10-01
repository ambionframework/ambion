/** The Pi execution: Pi's model services and one Pi executor for each seat. */

import { defineExecution } from '@ambionframework/ambion/hosting';
import { createPiExecutor } from './executor.ts';
import { createExecutionServices, type PiExecutionOptions } from './services.ts';

/**
 * The Pi execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock, limits, and logger when it builds the connector. It serves the
 * seats of kind `pi`. It does not change the default of that kind. Loading
 * the package defines that default, with no options.
 */
export const piExecution = defineExecution<PiExecutionOptions>('pi', (host, options = {}) => {
	const services = createExecutionServices(options);
	return (request) =>
		createPiExecutor({
			...services,
			definition: request.definition,
			now: () => host.clock.now(),
		});
});
