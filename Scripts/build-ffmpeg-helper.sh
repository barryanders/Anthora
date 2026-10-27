#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG_VERSION="8.1.2"
DAV1D_VERSION="1.5.4"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
DAV1D_SHA256="a1d5b63d2d38ec9bd03acf643caa51fa22edd1e89c5a109c4807717216bbec07"
BUILD_ROOT="${TMPDIR:-/tmp}/anthora-ffmpeg-build"
OUTPUT="$ROOT/Vendor/FFmpeg/darwin-arm64/AnthoraFFmpeg"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The current helper recipe targets Apple silicon macOS." >&2
  exit 1
fi
for command in curl meson ninja pkg-config make shasum; do
  command -v "$command" >/dev/null || { echo "Missing build tool: $command" >&2; exit 1; }
done

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT" "$(dirname "$OUTPUT")"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$BUILD_ROOT/ffmpeg.tar.xz"
curl -fsSL "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.gz" -o "$BUILD_ROOT/dav1d.tar.gz"
echo "$FFMPEG_SHA256  $BUILD_ROOT/ffmpeg.tar.xz" | shasum -a 256 -c -
echo "$DAV1D_SHA256  $BUILD_ROOT/dav1d.tar.gz" | shasum -a 256 -c -
tar -xf "$BUILD_ROOT/ffmpeg.tar.xz" -C "$BUILD_ROOT"
tar -xf "$BUILD_ROOT/dav1d.tar.gz" -C "$BUILD_ROOT"

meson setup "$BUILD_ROOT/dav1d-build" "$BUILD_ROOT/dav1d-$DAV1D_VERSION" \
  --prefix="$BUILD_ROOT/dav1d-install" --default-library=static \
  -Denable_tools=false -Denable_tests=false -Denable_examples=false
meson compile -C "$BUILD_ROOT/dav1d-build"
meson install -C "$BUILD_ROOT/dav1d-build"

cd "$BUILD_ROOT/ffmpeg-$FFMPEG_VERSION"
PKG_CONFIG_PATH="$BUILD_ROOT/dav1d-install/lib/pkgconfig" ./configure \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-network --disable-ffplay --disable-ffprobe --enable-ffmpeg \
  --enable-libdav1d --pkg-config-flags=--static --enable-protocol=file \
  --enable-demuxer=mov,matroska,flv --enable-decoder=libdav1d,vp9,flv \
  --enable-parser=av1,vp9 --enable-filter=scale --enable-encoder=mjpeg \
  --enable-muxer=image2
make -j"$(sysctl -n hw.logicalcpu)" ffmpeg
strip ffmpeg
cp ffmpeg "$OUTPUT"
chmod 755 "$OUTPUT"
echo "$OUTPUT"
