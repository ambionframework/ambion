/**
 * What the model reads when a compose call fails, through the real `compose`
 * tool and each real runtime: the error for a name that the call does not
 * bind, and the results of the calls that completed.
 */
import { type ComposeRuntime, defineTool, type ToolContext } from '@ambionframework/ambion';
import { describeExecutor, invokeTool } from '@ambionframework/ambion/hosting';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { processRuntime, quickjsRuntime } from '../src/runtime.ts';

const bash = defineTool({
	name: 'bash',
	description: 'Start a process.',
	parameters: Type.Object({ command: Type.String() }),
	execute: ({ command }) => `process ${command}`,
});

const wait = defineTool({
	name: 'wait',
	description: 'Wait for a process.',
	parameters: Type.Object({ process: Type.String() }),
	execute: () => 'done',
});

/** Node 22 has no `--allow-net`, so `processRuntime` refuses it. */
const permitted = process.allowedNodeEnvironmentFlags.has('--allow-net');

const memoryLimit = 64 * 1024 * 1024;

/** The message of the compose call that fails, with the tools of the seat. */
async function failure(runtime: ComposeRuntime, uses: string[], code: string): Promise<string> {
	const ctx: ToolContext = {
		agent: { name: 'worker', identity: 'Worker.' },
		callId: 'c1',
		deadline: Date.now() + 60_000,
	};
	const executor = describeExecutor({
		kind: 'test',
		instructions: 'Test.',
		tools: [bash, wait],
		compose: { runtime },
	});
	const compose = executor.tools.find((tool) => tool.name === 'compose');
	if (compose === undefined) throw new Error('The executor has no compose tool.');
	try {
		await invokeTool(compose, { uses, code }, ctx, () => {});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('The compose call did not fail.');
}

describe.each([
	['quickjsRuntime', true, () => quickjsRuntime({ memoryLimit, cpuLimit: 500 })],
	['processRuntime', permitted, () => processRuntime({ memoryLimit })],
])('%s in a compose call that fails', (_name, runs, runtime) => {
	it.runIf(runs)(
		'names the tool that the call leaves out of uses, and shows the results of the completed calls',
		async () => {
			const message = await failure(
				runtime(),
				['bash'],
				`for (const command of ['a', 'b', 'c']) await tools.bash({ command });
				 await tools.wait({ process: 'a' });`,
			);
			expect(message).toBe(
				[
					'The compose call failed: tools.wait is not bound. This call binds bash. Add wait to uses.',
					'Calls, in the order that the code made them:',
					'- c1.1 bash: completed',
					'  result: "process a"',
					'- c1.2 bash: completed',
					'  result: "process b"',
					'- c1.3 bash: completed',
					'  result: "process c"',
				].join('\n'),
			);
		},
	);
});
