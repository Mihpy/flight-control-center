#!/bin/zsh
# start.sh — запуск ИнтроСат ЦУП (Electron)
#
# Первый запуск на macOS: бинарник Electron нужно подписать.
# Скрипт делает это автоматически.
#
# Использование:
#   ./start.sh          — запустить приложение
#   ./start.sh --sign   — только подписать бинарник (если нужно вручную)

set -e
SCRIPT_DIR="${0:A:h}"
APP="$SCRIPT_DIR/node_modules/electron/dist/Electron.app"
BIN="$APP/Contents/MacOS/Electron"
ZIP="/tmp/electron-v31.zip"

# ── Шаг 1: скачать бинарник если нет ──────────────────────────────────────
if [ ! -f "$BIN" ] || [ "$(wc -c < "$BIN")" -lt 1000000 ]; then
  echo "⬇  Downloading Electron v31 for macOS arm64..."
  curl -L --progress-bar \
    "https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-darwin-arm64.zip" \
    -o "$ZIP"
  echo "📦 Extracting..."
  rm -rf "$APP"
  ditto -x -k "$ZIP" "$SCRIPT_DIR/node_modules/electron/dist/"
  echo "✅ Extracted."
fi

# ── Шаг 2: подписать если нужно ───────────────────────────────────────────
sign_app() {
  echo "✍  Ad-hoc codesigning Electron.app..."
  xattr -cr "$APP" 2>/dev/null || true

  codesign --sign - --force "$BIN" 2>/dev/null
  for helper in \
    "$APP/Contents/Frameworks/Electron Helper.app" \
    "$APP/Contents/Frameworks/Electron Helper (GPU).app" \
    "$APP/Contents/Frameworks/Electron Helper (Plugin).app" \
    "$APP/Contents/Frameworks/Electron Helper (Renderer).app"; do
    [ -d "$helper" ] || continue
    codesign --sign - --force "$helper/Contents/MacOS/"* 2>/dev/null
    codesign --sign - --force "$helper" 2>/dev/null
  done
  FW="$APP/Contents/Frameworks/Electron Framework.framework/Electron Framework"
  [ -f "$FW" ] && codesign --sign - --force "$FW" 2>/dev/null
  codesign --sign - --force "$APP" 2>/dev/null
  echo "✅ Signed."
}

if [ "$1" = "--sign" ]; then
  sign_app
  exit 0
fi

# Проверяем подпись; если не подписан — подписываем
if ! codesign -v "$BIN" 2>/dev/null; then
  sign_app
fi

# ── Шаг 3: запуск ─────────────────────────────────────────────────────────
echo "🚀 Starting ИнтроСат ЦУП..."
exec "$BIN" "$SCRIPT_DIR" "$@"
