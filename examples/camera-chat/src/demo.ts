import { callTool, quiet, type ScriptStep, scripted } from '@ambionframework/ambion/testing';

/** The demo reads the camera this many times, 100 ms apart, before it reports a failed start. */
const READS = 100;

/** The one name of the demo camera: its process name and its widget name. */
const NAME = 'front';

/** The path that the widget reads. */
const PATH = '/camera/observe';

/** The widget that the demo places once the camera answers. */
const viewfinder = (handle: string) => ({
	name: NAME,
	kind: 'frame',
	source: { type: 'process', handle, path: PATH },
	title: 'Front door',
});

/** The macro call that looks through the camera of the process `handle`. */
const observe = (handle: string) =>
	callTool('compose', { macro: 'camera/observe', args: { process: handle } });

/** The handle that a bash result names. */
// The handle format `bash-` plus 12 hex characters belongs to `packages/workspace/src/processes.ts`.
// A script result carries text only, so the demo reads the handle from it.
const handleOf = (text: string) => text.match(/bash-[0-9a-f]{12}/)?.[0] ?? '';

/** The snapshot refs that a macro result names. */
const refsOf = (text: string) => [
	...new Set(text.match(/ambion:\/\/workspace\/[^\s"',\]\\]+/g) ?? []),
];

function notReady(status: string) {
	return callTool('say', {
		to: 'you',
		text: `Demo agent: the camera server did not answer the observe macro. Last result:\n${status}`,
	});
}

/**
 * Run the seat on a script in place of Codex. The script calls the same
 * Git, process, compose, and widget tools of the seat, with no model and no Codex
 * login.
 */
export function demoExecution() {
	let phase = 0;
	let reads = 0;
	let seen: string[] = [];
	let handle = '';
	return scripted(async (step: ScriptStep) => {
		const last = step.results.at(-1)?.text ?? '';
		switch (phase++) {
			case 0:
				return callTool('fork', { source: 'templates/camera', name: 'camera', clone: '~/camera' });
			case 1:
				return callTool('bash', {
					command: 'cd ~/camera && node --test test.ts && git push origin main',
					wait: 10,
				});
			case 2:
				return callTool('bash', {
					command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts --demo',
					name: NAME,
					wait: 1,
					timeout: 86400,
				});
			case 3:
				handle = handleOf(last);
				return observe(handle);
			case 4: {
				// The server prints nothing when it listens, so read until it answers.
				const refs = refsOf(last);
				if (refs.length > 0) {
					seen = refs;
					return callTool('show', viewfinder(handle));
				}
				if (++reads > READS) {
					phase = 6;
					return notReady(last);
				}
				phase--;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				return observe(handle);
			}
			case 5:
				return callTool('say', {
					to: 'you',
					text: 'Demo agent: I cloned and started the camera template, and received a synthetic frame through the observe macro. This scripted reply does not perform visual inference.',
					refs: seen,
				});
			default:
				return quiet();
		}
	});
}
