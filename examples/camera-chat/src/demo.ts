import { callTool, quiet, type ScriptStep, scripted } from '@ambionframework/ambion/testing';

/** The demo reads the camera this many times, 100 ms apart, before it reports a failed start. */
const READS = 100;

const OBSERVE = { process: 'camera', path: '/camera/observe' };

function notReady(status: string) {
	return callTool('say', {
		to: 'you',
		text: `Demo agent: the camera server did not answer fetch. Last result:\n${status}`,
	});
}

/** The refs that a `fetch` result names. */
const refsOf = (text: string) => [...text.matchAll(/Snapshot ref: (\S+)/g)].map((m) => m[1] ?? '');

/**
 * Run the seat on a script in place of Codex. The script calls the same
 * Git, process, and fetch tools of the seat, with no model and no Codex
 * login.
 */
export function demoExecution() {
	let phase = 0;
	let reads = 0;
	let refs: string[] = [];
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
					name: 'camera',
					wait: 1,
					timeout: 86400,
				});
			case 3: {
				// The server prints nothing when it listens, so read until it answers.
				const digest = last.match(/"file":"([0-9a-f]{64})"/)?.[1];
				if (reads > 0 && digest) {
					refs = refsOf(last);
					return callTool('fetch', { process: 'camera', path: `/files/${digest}` });
				}
				if (++reads > READS) {
					phase = 5;
					return notReady(last);
				}
				phase--;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				return callTool('fetch', OBSERVE);
			}
			case 4:
				return callTool('say', {
					to: 'you',
					text: 'Demo agent: I cloned and started the camera template, and received a synthetic frame through fetch. This scripted reply does not perform visual inference.',
					refs: [...refs, ...refsOf(last)],
				});
			default:
				return quiet();
		}
	});
}
