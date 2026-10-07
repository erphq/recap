#!/bin/bash
# Builds Recap.app next to the project. The app's code is a link back to this
# folder, so edits show up the next time the app opens; no rebuild needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/electron/dist/Electron.app"
OUT="$ROOT/Recap.app"
[ -d "$SRC" ] || { echo "Electron is missing: run 'bun install' (or 'node node_modules/electron/install.js') first" >&2; exit 1; }

rm -rf "$OUT"
cp -R "$SRC" "$OUT"
PLIST="$OUT/Contents/Info.plist"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleName Recap" \
  -c "Set :CFBundleDisplayName Recap" \
  -c "Set :CFBundleIdentifier ai.erp.recap" \
  "$PLIST"
# Menu bar only: no Dock icon, no app switcher entry.
/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
cp "$ROOT/assets/recap.icns" "$OUT/Contents/Resources/electron.icns"
rm -f "$OUT/Contents/Resources/default_app.asar"
ln -s "$ROOT" "$OUT/Contents/Resources/app"
codesign --force --deep --sign - "$OUT" >/dev/null 2>&1
touch "$OUT"
echo "$OUT"
