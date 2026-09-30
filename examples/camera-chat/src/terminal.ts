import { type CliRenderer, createCliRenderer, resolveImageRenderProtocol } from '@opentui/core';

/** Require native graphics; never reduce camera frames to text cells. */
export function nativeProtocol(renderer: CliRenderer): 'kitty' | 'sixel' {
	const protocol = resolveImageRenderProtocol(
		'auto',
		renderer.capabilities,
		Boolean(renderer.resolution),
	);
	if (protocol === 'blocks')
		throw new Error(
			'Camera Chat requires a terminal with Kitty graphics or Sixel support (and pixel dimensions for Sixel). Native images are unavailable in this terminal.',
		);
	return protocol;
}

/** Allow terminal capability replies to arrive before rejecting the terminal. */
export async function createCameraRenderer(): Promise<CliRenderer> {
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15 });
	try {
		const deadline = Date.now() + 1500;
		while (
			resolveImageRenderProtocol('auto', renderer.capabilities, Boolean(renderer.resolution)) ===
				'blocks' &&
			Date.now() < deadline
		)
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		nativeProtocol(renderer);
		return renderer;
	} catch (error) {
		renderer.destroy();
		throw error;
	}
}
