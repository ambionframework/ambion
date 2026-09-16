import { openDemo } from './server.ts';

const [mode, directory = '.data'] = process.argv.slice(2);
if (mode !== 'start' && mode !== 'resume') throw new Error('Use start or resume [directory].');
const demo = await openDemo(directory, mode);
let closing = false;
async function stop() {
	if (closing) return;
	closing = true;
	await demo.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
demo.server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
	const address = demo.server.address();
	if (address && typeof address !== 'string')
		console.log(`Ambion ready on http://127.0.0.1:${address.port}; PID ${process.pid}`);
});
