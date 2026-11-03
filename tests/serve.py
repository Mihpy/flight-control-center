#!/usr/bin/env python3
"""
Локальный сервер для проверок: отдаёт файлы без кэширования.

Обычный http.server позволяет браузеру держать старую копию js/app.js,
и после правки фаззинг продолжает находить уже исправленные ошибки.

Запуск:  python3 tests/serve.py [порт]
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_response(self, code, message=None):
        # 304 Not Modified приводит к использованию старой копии
        if code == 304:
            code = 200
        super().send_response(code, message)

    def log_message(self, *args):
        pass


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"проверочный сервер: http://127.0.0.1:{port}/  (корень {ROOT})")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())