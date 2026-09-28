/**
 * The S3 object backend: `s3ObjectBackend` over Amazon S3, Cloudflare R2,
 * or MinIO. This entry loads `aws4fetch`, and the root entry does not.
 */

export type { S3ObjectBackendOptions } from './s3.ts';
export { s3ObjectBackend } from './s3.ts';
