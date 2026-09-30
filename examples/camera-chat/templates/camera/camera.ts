import { execFile, spawn } from 'node:child_process';
import { type Frame, FrameDecoder, frameFromRgb, HEIGHT, WIDTH } from './frame.ts';

const executable = () => process.env.CAMERA_FFMPEG ?? 'ffmpeg';

/** Read AVFoundation video devices. FFmpeg exits unsuccessfully after listing. */
export async function listCameras(): Promise<{ index: string; name: string }[]> {
	const listing = await new Promise<string>((resolve, reject) => {
		execFile(
			executable(),
			['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
			{ timeout: 10000 },
			(error, _stdout, stderr) => {
				if (error && 'code' in error && error.code === 'ENOENT')
					reject(new Error('Install FFmpeg with: brew install ffmpeg'));
				else resolve(stderr);
			},
		);
	});
	return parseCameras(listing);
}

export function parseCameras(listing: string): { index: string; name: string }[] {
	const video =
		listing.split('AVFoundation video devices:')[1]?.split('AVFoundation audio devices:')[0] ?? '';
	return [...video.matchAll(/\[(\d+)\]\s+([^\r\n]+)/g)].map((match) => ({
		index: match[1] ?? '',
		name: match[2]?.trim() ?? '',
	}));
}

export async function builtInCamera(): Promise<string> {
	const cameras = await listCameras();
	const camera =
		cameras.find(({ name }) => /built.in|MacBook.*Camera/i.test(name)) ??
		cameras.find(({ name }) => /FaceTime|iSight/i.test(name));
	if (!camera)
		throw new Error('No built-in camera found. Use --list-cameras, then --device <index>.');
	return camera.index;
}

/** Acquire five frames each second. Audio capture stays disabled. */
export function startCamera(
	device: string,
	receive: (frame: Frame) => void,
	fail: (message: string) => void,
) {
	const child = spawn(
		executable(),
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-nostdin',
			'-f',
			'avfoundation',
			'-framerate',
			'30',
			'-video_size',
			`${WIDTH}x${HEIGHT}`,
			'-i',
			`${device}:none`,
			'-an',
			'-vf',
			`fps=5,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const decoder = new FrameDecoder();
	let diagnostic = '';
	let stopping = false;
	child.stdout.on('data', (bytes: Buffer) => {
		try {
			for (const rgb of decoder.push(bytes)) receive(frameFromRgb(rgb));
		} catch (error) {
			fail(String(error));
			child.kill('SIGTERM');
		}
	});
	child.stderr.on('data', (bytes: Buffer) => {
		diagnostic = (diagnostic + bytes.toString()).slice(-4000);
	});
	child.on('error', (error) => fail(error.message));
	child.on('close', (code) => {
		if (!stopping) fail(`Camera stopped (${code}). ${diagnostic}`);
	});
	return async () => {
		stopping = true;
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const force = setTimeout(() => child.kill('SIGKILL'), 2000);
			child.once('close', () => {
				clearTimeout(force);
				resolve();
			});
			child.kill('SIGTERM');
		});
	};
}
