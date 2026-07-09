#!/usr/bin/env bash
#
# Redeploy the Agora macOS desktop app without leaving duplicates behind.
#
# Why this exists: `tauri build` writes a bundle into target/release/bundle/macos
# and macOS auto-registers it with LaunchServices. Copying another copy into
# /Applications then leaves TWO bundles registered under the same identifier
# (app.agora.desktop) -> duplicate entries in Launchpad, notification settings,
# and `open -a`. The app also stays alive after its window closes, so swapping
# the bundle while it runs leaves a stale process behind.
#
# This script does the clean sequence: quit -> build -> replace in place ->
# unregister the build-dir copy -> relaunch the /Applications copy.
#
# Usage:
#   scripts/redeploy.sh            # build + install + relaunch
#   scripts/redeploy.sh --no-open  # build + install, don't relaunch

set -euo pipefail

NO_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --no-open) NO_OPEN=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/crates/agora-desktop"
BUILD_APP="$REPO_ROOT/target/release/bundle/macos/Agora.app"
INSTALLED_APP="/Applications/Agora.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> Quitting any running Agora instance"
# Window-close is not enough; the app keeps running in the background.
osascript -e 'quit app "Agora"' 2>/dev/null || true
sleep 2
pkill -f 'Agora.app/Contents/MacOS/agora-desktop' 2>/dev/null || true
sleep 1

echo "==> Building the app bundle"
# Build into the repo's own target/ dir, not a redirected/temp CARGO_TARGET_DIR
# (a stray CARGO_TARGET_DIR pointing at a sandbox temp dir breaks the build).
unset CARGO_TARGET_DIR
# Make sure cargo is on PATH; a non-login/non-interactive shell may not have it,
# which makes Tauri's `cargo metadata` fail with "No such file or directory".
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *) PATH="$HOME/.cargo/bin:$PATH" ;; esac
export PATH
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH; install Rust (https://rustup.rs) or fix PATH" >&2
  exit 1
fi
# --yes so npx never stops to prompt for the tauri CLI install.
( cd "$DESKTOP_DIR" && npx --yes @tauri-apps/cli@latest build --bundles app )

if [[ ! -d "$BUILD_APP" ]]; then
  echo "error: expected bundle not found at $BUILD_APP" >&2
  exit 1
fi

echo "==> Installing to $INSTALLED_APP (replacing in place)"
rm -rf "$INSTALLED_APP"
ditto "$BUILD_APP" "$INSTALLED_APP"

echo "==> Deduplicating LaunchServices registrations"
# Drop the build-dir bundle so only the /Applications copy is registered.
"$LSREG" -u "$BUILD_APP" 2>/dev/null || true
"$LSREG" -f "$INSTALLED_APP"

echo "==> Registered Agora bundles now:"
"$LSREG" -dump 2>/dev/null | grep -iE "Agora\.app" | grep -i "path:" | sort -u || true

if [[ "$NO_OPEN" -eq 0 ]]; then
  echo "==> Launching $INSTALLED_APP"
  open "$INSTALLED_APP"
fi

echo "==> Done."
