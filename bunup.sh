#!/bin/sh
# Pin Bun to 1.3.14 with SHA-256 verification.
#
# Single source of truth for the pinned Bun version + hashes. If you bump it,
# update BOTH this file and the CI jobs (.gitlab-ci.yml), then run the full
# test gate (`bun run test`) and regenerate the hashes from the official
# SHASUMS256.txt of the release you pin to.
#
# Hashes below were verified against
# https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt
VERSION="1.3.14"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-x64)  TARGET="bun-linux-x64";        SHA256="951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f" ;;
  Linux-arm64|Linux-aarch64) TARGET="bun-linux-aarch64";  SHA256="a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b" ;;
  Darwin-x86_64)            TARGET="bun-darwin-x64";      SHA256="4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633" ;;
  Darwin-arm64|Darwin-aarch64) TARGET="bun-darwin-aarch64"; SHA256="d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620" ;;
  *)
    echo "bunup: unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

set -e

INSTALL_DIR="${BUN_INSTALL:-$HOME/.bun}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

URL="https://github.com/oven-sh/bun/releases/download/bun-v${VERSION}/${TARGET}.zip"
echo "bunup: downloading ${URL}"
curl -fsSL "$URL" -o "$WORK/bun.zip"

echo "${SHA256}  $WORK/bun.zip" | sha256sum -c - >/dev/null 2>&1 || {
  # macOS lacks sha256sum by default; fall back to shasum.
  echo "${SHA256}  $WORK/bun.zip" | shasum -a 256 -c - >/dev/null 2>&1 || {
    echo "bunup: SHA-256 mismatch for ${TARGET}.zip" >&2
    exit 1
  }
}

mkdir -p "$INSTALL_DIR"
unzip -qo "$WORK/bun.zip" -d "$INSTALL_DIR"
ln -sf "$INSTALL_DIR/${TARGET}/bun" "$INSTALL_DIR/bun"

echo "bunup: installed bun ${VERSION} at $INSTALL_DIR/bun"
"$INSTALL_DIR/bun" --version
