#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_VERSION="3.14"
PYTHON_PREFIX="${ANTHORA_PYTHON_PREFIX:-/opt/homebrew/opt/python@3.14}"
PYTHON_SOURCE="$PYTHON_PREFIX/Frameworks/Python.framework/Versions/$PYTHON_VERSION"
DIST_ROOT="$ROOT/.build/anthora-service-helper/AnthoraService"
PYTHON_ROOT="$DIST_ROOT/Python"
STDLIB_ROOT="$PYTHON_ROOT/stdlib"
STDLIB_SOURCE="$PYTHON_SOURCE/lib/python$PYTHON_VERSION"
PYTHON_EXECUTABLE="$PYTHON_SOURCE/Resources/Python.app/Contents/MacOS/Python"

for required in "$PYTHON_SOURCE/Python" "$PYTHON_EXECUTABLE" "$STDLIB_SOURCE"; do
  test -e "$required" || {
    echo "Missing Python $PYTHON_VERSION framework component: $required" >&2
    exit 1
  }
done

rm -rf "$DIST_ROOT"
mkdir -p "$PYTHON_ROOT/bin" "$PYTHON_ROOT/lib" "$STDLIB_ROOT"

cp "$PYTHON_SOURCE/Python" "$PYTHON_ROOT/Python"
cp "$PYTHON_EXECUTABLE" "$PYTHON_ROOT/bin/python3"
rsync -a \
  --exclude '__pycache__/' \
  --exclude 'site-packages' \
  --exclude 'test/' \
  --exclude 'tests/' \
  --exclude 'tkinter/' \
  --exclude 'turtledemo/' \
  --exclude 'idlelib/' \
  --exclude 'ensurepip/' \
  --exclude 'venv/' \
  --exclude 'lib2to3/' \
  --exclude 'distutils/' \
  --exclude "config-$PYTHON_VERSION-darwin/" \
  "$STDLIB_SOURCE/" "$STDLIB_ROOT/"
find "$STDLIB_ROOT" -type f -name '*.py' -exec chmod 0644 {} +
ln -s ../stdlib "$PYTHON_ROOT/lib/python$PYTHON_VERSION"

cp /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib "$PYTHON_ROOT/lib/"
cp /opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib "$PYTHON_ROOT/lib/"
cp /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib "$PYTHON_ROOT/lib/"
cp /opt/homebrew/opt/xz/lib/liblzma.5.dylib "$PYTHON_ROOT/lib/"
cp /opt/homebrew/opt/zstd/lib/libzstd.1.dylib "$PYTHON_ROOT/lib/"
cp /opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib "$PYTHON_ROOT/lib/"

for library in "$PYTHON_ROOT"/lib/*.dylib; do
  install_name_tool -id "@loader_path/$(basename "$library")" "$library"
done

install_name_tool -id "@rpath/Python" "$PYTHON_ROOT/Python"
PYTHON_DEPENDENCY="$(otool -L "$PYTHON_EXECUTABLE" | awk 'NR>1 && /Python\.framework/{print $1; exit}')"
install_name_tool -change \
  "$PYTHON_DEPENDENCY" \
  "@executable_path/../Python" \
  "$PYTHON_ROOT/bin/python3"

for module in "$STDLIB_ROOT"/lib-dynload/*.so; do
  install_name_tool -change \
    "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib" \
    "@loader_path/../../lib/libssl.3.dylib" \
    "$module" 2>/dev/null || true
  install_name_tool -change \
    "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" \
    "@loader_path/../../lib/libcrypto.3.dylib" \
    "$module" 2>/dev/null || true
  install_name_tool -change \
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib" \
    "@loader_path/../../lib/libsqlite3.dylib" \
    "$module" 2>/dev/null || true
  install_name_tool -change \
    "/opt/homebrew/opt/xz/lib/liblzma.5.dylib" \
    "@loader_path/../../lib/liblzma.5.dylib" \
    "$module" 2>/dev/null || true
  install_name_tool -change \
    "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib" \
    "@loader_path/../../lib/libzstd.1.dylib" \
    "$module" 2>/dev/null || true
  install_name_tool -change \
    "/opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib" \
    "@loader_path/../../lib/libmpdec.4.dylib" \
    "$module" 2>/dev/null || true
done
CRYPTO_DEPENDENCY="$(otool -L /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib | awk '/libcrypto/{print $1; exit}')"
install_name_tool -change \
  "$CRYPTO_DEPENDENCY" \
  "@loader_path/libcrypto.3.dylib" \
  "$PYTHON_ROOT/lib/libssl.3.dylib"

while IFS= read -r binary; do
  if file "$binary" | grep -q 'Mach-O'; then
    codesign --force --sign - "$binary" >/dev/null 2>&1
  fi
done < <(find "$PYTHON_ROOT" -type f)
codesign --force --sign - \
  --identifier com.anthora.service-python \
  --requirements '=designated => identifier "com.anthora.service-python"' \
  "$PYTHON_ROOT/bin/python3" >/dev/null 2>&1

cp "$ROOT/Service/anthora_service.py" "$DIST_ROOT/anthora_service.py"
cp "$ROOT/Support/AnthoraServiceLauncher" "$DIST_ROOT/AnthoraService.sh"
cp "$STDLIB_SOURCE/LICENSE.txt" "$DIST_ROOT/PYTHON_LICENSE.txt"
chmod 0644 "$DIST_ROOT/AnthoraService.sh"
chmod +x "$PYTHON_ROOT/bin/python3"

/bin/sh "$DIST_ROOT/AnthoraService.sh" --help >/dev/null
echo "$DIST_ROOT"
