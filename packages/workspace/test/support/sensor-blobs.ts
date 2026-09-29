import { createHash } from 'node:crypto';

export const frameBytes = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
	'hex',
);
export const fileBytes = Buffer.from('at,voltage\n2026-09-29T10:00:00.000Z,5.01\n', 'utf8');
export const frameDigest = createHash('sha256').update(frameBytes).digest('hex');
export const fileDigest = createHash('sha256').update(fileBytes).digest('hex');
