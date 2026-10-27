#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/Anthora.app}"

cd "$ROOT"
SWIFT_BUILD_ARGS=()
# Allows a known-good installed SDK when the latest beta CLT lacks UI macros.
# This does not change the machine's selected developer tools.
if [[ -n "${ANTHORA_SWIFT_SDK:-}" ]]; then
  SWIFT_BUILD_ARGS=(--sdk "$ANTHORA_SWIFT_SDK")
fi
swift build -c release ${SWIFT_BUILD_ARGS[@]+"${SWIFT_BUILD_ARGS[@]}"} --product AnthoraApp
swift build -c release ${SWIFT_BUILD_ARGS[@]+"${SWIFT_BUILD_ARGS[@]}"} --product AnthoraMediaReader
swift build -c release ${SWIFT_BUILD_ARGS[@]+"${SWIFT_BUILD_ARGS[@]}"} --product AnthoraPhotosBridge
npm --prefix Web run build
Scripts/build-service-helper.sh
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Helpers" "$OUTPUT/Contents/Resources"
cp .build/release/AnthoraApp "$OUTPUT/Contents/MacOS/Anthora"
cp .build/release/AnthoraMediaReader "$OUTPUT/Contents/Helpers/AnthoraMediaReader"
cp .build/release/AnthoraPhotosBridge "$OUTPUT/Contents/Helpers/AnthoraPhotosBridge"
cp -R .build/anthora-service-helper/AnthoraService "$OUTPUT/Contents/Resources/AnthoraService"
cp -R Web/dist "$OUTPUT/Contents/Resources/Web"
FFMPEG_HELPER="$ROOT/Vendor/FFmpeg/darwin-arm64/AnthoraFFmpeg"
if [[ ! -x "$FFMPEG_HELPER" ]]; then
  echo "Missing FFmpeg helper. Run Scripts/build-ffmpeg-helper.sh first." >&2
  exit 1
fi
cp "$FFMPEG_HELPER" "$OUTPUT/Contents/Helpers/AnthoraFFmpeg"
cp Release/Customer/THIRD_PARTY_NOTICES.md "$OUTPUT/Contents/Resources/THIRD_PARTY_NOTICES.md"
cp Vendor/FFmpeg/COPYING.LGPLv2.1 Vendor/FFmpeg/COPYING.dav1d "$OUTPUT/Contents/Resources/"
cp Legal/APACHE-2.0.txt "$OUTPUT/Contents/Resources/APACHE-2.0.txt"
cp Release/Customer/LICENSE.txt "$OUTPUT/Contents/Resources/ANTHORA_LICENSE.txt"
cp Release/Customer/PRIVACY.md "$OUTPUT/Contents/Resources/PRIVACY.md"
if [[ "${ANTHORA_INCLUDE_PHOTOS_HOST:-0}" == "1" ]]; then
  cp Support/AnthoraPhotosHost "$OUTPUT/Contents/Resources/AnthoraPhotosHost"
  chmod +x "$OUTPUT/Contents/Resources/AnthoraPhotosHost"
fi
cp Support/AnthoraInfo.plist "$OUTPUT/Contents/Info.plist"
if [[ -f Support/AnthoraIcon.icns ]]; then
  cp Support/AnthoraIcon.icns "$OUTPUT/Contents/Resources/AnthoraIcon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AnthoraIcon" "$OUTPUT/Contents/Info.plist"
fi
if [[ -d Models/FaceEmbedding.mlpackage ]]; then
  cp -R Models/FaceEmbedding.mlpackage "$OUTPUT/Contents/Resources/"
fi
# Remove compiler source paths from distributable native binaries before signing.
strip -S "$OUTPUT/Contents/MacOS/Anthora" "$OUTPUT/Contents/Helpers/AnthoraMediaReader" "$OUTPUT/Contents/Helpers/AnthoraPhotosBridge"
codesign --force --sign - --identifier com.anthora.media-reader \
  --requirements '=designated => identifier "com.anthora.media-reader"' \
  "$OUTPUT/Contents/Helpers/AnthoraMediaReader"
codesign --force --sign - --identifier com.anthora.photos-bridge \
  --requirements '=designated => identifier "com.anthora.photos-bridge"' \
  "$OUTPUT/Contents/Helpers/AnthoraPhotosBridge"
codesign --force --sign - --identifier com.anthora.ffmpeg \
  --requirements '=designated => identifier "com.anthora.ffmpeg"' \
  "$OUTPUT/Contents/Helpers/AnthoraFFmpeg"
codesign --force --sign - --identifier com.anthora \
  --requirements '=designated => identifier "com.anthora"' \
  "$OUTPUT"
echo "$OUTPUT"
