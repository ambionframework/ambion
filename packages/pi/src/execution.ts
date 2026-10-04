/** The Pi execution: Pi's model services and one Pi executor for each seat. */

import { localExecution } from '@ambionframework/ambion/hosting';
import { createPiOpener } from './executor.ts';
import { createExecutionServices, type PiExecutionOptions } from './services.ts';

/**
 * The Pi execution for a runtime or a room. Pass it as `execution` to
 * `createRuntime`, `startRoom` or `resumeRoom`. The runtime supplies its
 * clock when it builds the connector. It serves the
 * seats of kind `pi`.
 */
export function piExecution(options: PiExecutionOptions = {}) {
	return localExecution('pi', (host) => {
		const services = createExecutionServices(options);
		return (request) =>
			createPiOpener({
				...services,
				definition: request.definition,
				now: () => host.clock.now(),
			});
	});
}
