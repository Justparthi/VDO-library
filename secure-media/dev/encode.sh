#!/usr/bin/env bash
# dev/encode.sh
#
# Encodes a source MP4 into multi-quality HLS and uploads it to the output bucket.
#
# Usage:
#   ./dev/encode.sh <mediaId> [source.mp4]
#
# If source.mp4 is omitted, it is downloaded from the source bucket first.
# Output is uploaded to the output bucket under: videos/<mediaId>/
#
# Requires: ffmpeg, aws CLI (configured to point at local SeaweedFS)
#
# Environment (read from .env if present):
#   S3_ENDPOINT       default: http://localhost:8333
#   SOURCE_BUCKET     default: source
#   DEST_BUCKET       default: output
#   AWS_ACCESS_KEY_ID       default: local
#   AWS_SECRET_ACCESS_KEY   default: local
#   AWS_DEFAULT_REGION      default: us-east-1

set -euo pipefail

# ── Load .env if present ──────────────────────────────────────────────────────
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

MEDIA_ID="${1:?Usage: encode.sh <mediaId> [source.mp4]}"
SOURCE_FILE="${2:-}"

S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:8333}"
SOURCE_BUCKET="${SOURCE_BUCKET:-source}"
DEST_BUCKET="${DEST_BUCKET:-output}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

AWS="aws --endpoint-url $S3_ENDPOINT"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ── Download source if not provided ──────────────────────────────────────────
if [ -z "$SOURCE_FILE" ]; then
  echo "⬇️  Downloading s3://$SOURCE_BUCKET/$MEDIA_ID.mp4 ..."
  SOURCE_FILE="$WORK_DIR/source.mp4"
  $AWS s3 cp "s3://$SOURCE_BUCKET/$MEDIA_ID.mp4" "$SOURCE_FILE"
fi

OUT_DIR="$WORK_DIR/hls"
mkdir -p "$OUT_DIR"

PREFIX="videos/$MEDIA_ID"

echo "🎬  Encoding $SOURCE_FILE → 360p / 720p / 1080p HLS ..."

# ── Per-quality renditions ─────────────────────────────────────────────────
ffmpeg -hide_banner -loglevel warning \
  -i "$SOURCE_FILE" \
  \
  -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 \
  \
  -c:v:0 libx264 -b:v:0 800k   -s:v:0 640x360   -c:a:0 aac -b:a:0 96k  \
  -c:v:1 libx264 -b:v:1 2800k  -s:v:1 1280x720  -c:a:1 aac -b:a:1 128k \
  -c:v:2 libx264 -b:v:2 5000k  -s:v:2 1920x1080 -c:a:2 aac -b:a:2 192k \
  \
  -var_stream_map "v:0,a:0,name:360p v:1,a:1,name:720p v:2,a:2,name:1080p" \
  \
  -f hls \
  -hls_time 6 \
  -hls_playlist_type vod \
  -hls_segment_filename "$OUT_DIR/%v/seg%d.ts" \
  -master_pl_name master.m3u8 \
  "$OUT_DIR/%v/index.m3u8"

echo "⬆️  Uploading HLS to s3://$DEST_BUCKET/$PREFIX/ ..."
$AWS s3 sync "$OUT_DIR/" "s3://$DEST_BUCKET/$PREFIX/" --content-type "application/octet-stream"

# Fix MIME types for playlist files
for playlist in $(find "$OUT_DIR" -name "*.m3u8"); do
  KEY="$PREFIX/${playlist#$OUT_DIR/}"
  $AWS s3 cp "$playlist" "s3://$DEST_BUCKET/$KEY" \
    --content-type "application/vnd.apple.mpegurl"
done

echo "✅  Done. Manifest at: s3://$DEST_BUCKET/$PREFIX/master.m3u8"
echo "    CDN URL:           https://\${CDN_DOMAIN}/$PREFIX/master.m3u8"
