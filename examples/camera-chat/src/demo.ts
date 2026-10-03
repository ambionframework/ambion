import { callTool, quiet, type ScriptStep, scripted } from '@ambionframework/ambion/testing';

/** The demo reads the process this many times, 100 ms apart, before it reports a failed start. */
const READY_READS = 100;

function notReady(status: string) {
	return callTool('say', {
		to: 'you',
		text: `Demo agent: the camera server did not report READY. Last status:\n${status}`,
	});
}

/**
 * Run the seat on a script in place of Codex. The script calls the same
 * Git, process, connect, and observe tools of the seat, with no model and no
 * Codex login.
 */
export function demoExecution() {
	let phase = 0;
	let reads = 0;
	let handle = '';
	let port = 0;
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
				handle ||= last.match(/bash-[a-f0-9]+/)?.[0] ?? '';
				port = Number(last.match(/READY \{"port":(\d+)/)?.[1]);
				if (port) return callTool('connect', { name: 'camera', process: handle, port });
				if (++reads > READY_READS) {
					phase = 6;
					return notReady(last);
				}
				phase--;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				return callTool('wait', { handles: [handle], timeout: 0 });
			}
			case 4:
				return callTool('observe', { sensor: 'camera/camera' });
			case 5:
				return callTool('say', {
					to: 'you',
					text: 'Demo agent: I cloned and started the camera template, connected its sensor link, and received a synthetic frame through observe. This scripted reply does not perform visual inference.',
					refs: [last.match(/Snapshot ref: (\S+)/)?.[1]].filter((ref): ref is string =>
						Boolean(ref),
					),
				});
			default:
				return quiet();
		}
	});
}
