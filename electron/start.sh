#!/bin/zsh
# start.sh — запуск Electron-приложения ИнтроСат ЦУП
#
# Если приложение не запускается (SIGKILL от macOS Gatekeeper),
# сначала выполни подпись бинарника:
#
#   ./start.sh --sign
#
# После этого обычный запуск:
#
#   ./start.sh          (или npm start)

SCRIPT_DIR="${0:A:h}"
ELECTRON="$SCRIPT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# Скачиваем бинарник если нет
if [ ! -f "$ELECTRON" ] || [ "$(wc -c < "$ELECTRON")" -lt 1000000 ]; then
  echo "⬇  Electron binary not found or too small, extracting from zip..."
  if [ -f /tmp/electron-v31.zip ]; then
    ditto -x -k /tmp/electron-v31.zip "$SCRIPT_DIR/node_modules/electron/dist/"
  else
    echo "❌  /tmp/electron-v31.zip not found."
    echo "   Download it manually:"
    echo "   curl -L 'https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-darwin-arm64.zip' -o /tmp/electron-v31.zip"
    echo "   Then run: ./start.sh"
    exit 1
  fi
fi

# Подпись (нужна один раз на macOS 13+)
if [ "$1" = "--sign" ]; then
  echo "✍  Ad-hoc codesigning Electron.app (requires macOS developer tools)..."
  APP="$SCRIPT_DIR/node_modules/electron/dist/Electron.app"
  find "$APP" -name "*.dylib" -o -name "*.so" | while read f; do
    codesign --sign - --force "$f" 2>/dev/null
  done
  find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" | while read f; do
    codesign --sign - --force --deep "$f" 2>/dev/null
  done
  find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" | while read f; do
    codesign --sign - --force --deep "$f" 2>/dev/null
  done
  codesign --sign - --force "$APP/Contents/MacOS/Electron"
  codesign --sign - --force --deep "$APP"
  xattr -cr "$APP"
  echo "✅  Done. Now run: ./start.sh"
  exit 0
fi

# Запуск
exec "$ELECTRON" "$SCRIPT_DIR" "$@"
