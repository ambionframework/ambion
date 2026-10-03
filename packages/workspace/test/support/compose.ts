/**
 * One compose call over the tools of a workspace, for the tests that read
 * the declared output of a tool. The call runs in the `functionRuntime`
 * of the core's test support, and through the `compose` tool that
 * `describeExecutor` appends, so the check of the declared output runs on
 * the real result of each tool.
 */
import type { ComposeResult, ToolBundle } from '@ambionframework/ambion';
import { describeExecutor, invokeTool } from '@ambionframework/ambion/hosting';
import { functionRuntime } from '../../../ambion/test/support/compose-runtime.ts';
import { callAs } from './backends.ts';

/**
 * Run `code` with the tools in `uses`, as `agent`, and give the `ComposeResult`.
 * A failed call throws, and its message renders the error and the ledger.
 */
export async function composed(
	bundle: ToolBundle,
	uses: readonly string[],
	code: string,
	agent = 'ada',
): Promise<ComposeResult> {
	const executor = describeExecutor({
		kind: 'test',
		instructions: 'Test.',
		bundles: [bundle],
		compose: { runtime: functionRuntime },
	});
	const tool = executor.tools.find((one) => one.name === 'compose');
	if (tool === undefined) throw new Error('The executor has no compose tool.');
	const result = await invokeTool(
		tool,
		{ uses, code },
		callAs(agent, { room: 'lobby', deadline: Date.now() + 60_000 }),
	);
	if (typeof result === 'string') throw new Error('compose returned a string.');
	return result.details as ComposeResult;
}
