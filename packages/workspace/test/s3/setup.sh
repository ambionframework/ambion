#!/usr/bin/env bash
# Start MinIO in Docker for the S3 tier, and write the file the tier reads.
#
# Usage: bash test/s3/setup.sh <state dir>
#
# The official minio/minio image no longer exists on Docker Hub. The tier
# runs Chainguard's build, pinned by digest. Only its `latest` tag is free,
# so the digest names the build that the tier last proved (2026-09-27).
#
# The container keeps /data on a tmpfs that the image's user (65532) owns.
# A bind mount fails on permissions, and the image's overlay /data fails a
# rename, so the tmpfs is required. The tier needs no data after it ends.
set -euo pipefail

STATE="${1:?Usage: setup.sh <state dir>}"
IMAGE="cgr.dev/chainguard/minio@sha256:6a1d0b45c8669726bba580ced0bfa4cb9fdeed1ed636dfabd81d1577beb6937b"
NAME="ambion-s3"
PORT="${AMBION_S3_PORT:-9000}"
USER_NAME="ambion"
SECRET="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

mkdir -p "$STATE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:9000" \
	-e MINIO_ROOT_USER="$USER_NAME" -e MINIO_ROOT_PASSWORD="$SECRET" \
	--tmpfs /data:rw,uid=65532,gid=65532 \
	"$IMAGE" server /data >/dev/null

for _ in $(seq 1 30); do
	if curl -sf "http://127.0.0.1:$PORT/minio/health/live" >/dev/null; then break; fi
	sleep 1
done
curl -sf "http://127.0.0.1:$PORT/minio/health/live" >/dev/null || {
	docker logs "$NAME" >&2
	exit 1
}

cat >"$STATE/s3.json" <<JSON
{
	"endpoint": "http://127.0.0.1:$PORT",
	"region": "us-east-1",
	"bucket": "ambion-snapshots",
	"accessKeyId": "$USER_NAME",
	"secretAccessKey": "$SECRET"
}
JSON
echo "s3: $STATE/s3.json"
