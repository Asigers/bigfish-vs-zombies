#!/usr/bin/env bash
# Verify the native bridge: build the game-agnostic core, run its tests, then
# compile the PvZ-Portable facade against real upstream headers.
#
#   ./scripts/native-check.sh              # clone + patch + build (cached)
#   PVZ_DIR=/path/to/pvzp ./scripts/native-check.sh   # use an existing checkout
#
# This never downloads game assets. It proves the bridge compiles and that its
# protocol/idempotency logic is correct; it cannot prove gameplay without a
# legally owned main.pak (see docs/M0-STATUS.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native"
LOCK="$NATIVE/pvz-portable.lock"
VENDOR="${PVZ_DIR:-$NATIVE/vendor/PvZ-Portable}"
BUILD="$NATIVE/build"
GAME_BUILD="$NATIVE/vendor/build"
CMAKE="${CMAKE:-cmake}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}
need git
need "$CMAKE"

echo "==> 1/5 bridge core (no game code required)"
"$CMAKE" -S "$NATIVE" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
"$CMAKE" --build "$BUILD" >/dev/null
"$BUILD/bigfish_core_test"

echo "==> 2/5 PvZ-Portable checkout"
REPO="$(sed -n 's/^repo=//p' "$LOCK")"
COMMIT="$(sed -n 's/^commit=//p' "$LOCK")"
if [ ! -d "$VENDOR/.git" ]; then
  mkdir -p "$(dirname "$VENDOR")"
  git clone "$REPO" "$VENDOR"
fi
git -C "$VENDOR" fetch --quiet origin "$COMMIT" || true
git -C "$VENDOR" checkout --quiet "$COMMIT"

echo "==> 3/5 copy bridge + apply hooks"
rm -rf "$VENDOR/bigfish-bridge"
mkdir -p "$VENDOR/bigfish-bridge"
cp "$NATIVE"/*.h "$NATIVE"/*.cpp "$VENDOR/bigfish-bridge/"
cp "$NATIVE/Bridge.cmake" "$VENDOR/bigfish-bridge/"
if git -C "$VENDOR" apply --check "$NATIVE/patches/0001-bridge-hooks.patch" 2>/dev/null; then
  git -C "$VENDOR" apply "$NATIVE/patches/0001-bridge-hooks.patch"
elif git -C "$VENDOR" apply --reverse --check "$NATIVE/patches/0001-bridge-hooks.patch" 2>/dev/null; then
  echo "    hooks already applied"
else
  echo "patch does not apply to $COMMIT" >&2
  exit 1
fi

echo "==> 4/5 configure PvZ-Portable with the bridge"
"$CMAKE" -S "$VENDOR" -B "$GAME_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBIGFISH_BRIDGE=ON >/dev/null

echo "==> 5/5 compile"
"$CMAKE" --build "$GAME_BUILD" -j "$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
  --target pvz-portable >/dev/null

echo
echo "native bridge OK:"
echo "  core tests     $BUILD/bigfish_core_test"
echo "  game binary    $GAME_BUILD/pvz-portable"
echo "  (runtime still needs legally owned main.pak + properties/)"
