#!/usr/bin/env python3
"""
Эмулятор телеметрии для проверок.

Повторяет поведение mcc-hack/data-emulator в объёме, важном для пульта:
  GET /telemetry — последний кадр, 204 пока данных нет;
  любой другой путь — 404 (признак «борт только слушает»);
  GET /command   — по флагу --commands отвечает 405, иначе 404.

Проверяет, что пульт по-прежнему принимает поток, а канал команд
определяется верно при обоих ответах.

Запуск:  python3 tests/mock_emulator.py [--port 8765] [--commands] [--chaos]
"""

from __future__ import annotations

import argparse
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PRE, POST = "AA55", "0D0A"
STATE = {"frame": None, "mk": 0, "start": time.time(), "hits": 0, "frames": 0}


def make_frame(mk: int, chaos: bool) -> str:
    t = mk * 0.1
    acc = 16384 + int(900 * math.sin(t * 0.7))
    mag = 200 + int(120 * math.sin(t * 0.31))
    parts = [
        PRE, str(mk),
        str(7200 + int(600 * math.sin(t * 0.21))),          # АКБ, мВ
        str(3000 + int(900 * math.sin(t * 0.5))),            # СД1
        str(3000 + int(900 * math.sin(t * 0.61))),           # СД2
        str(3000 + int(900 * math.sin(t * 0.73))),           # СД3
        str(3000 + int(900 * math.sin(t * 0.83))),           # СД4
        str(acc), str(acc // 2), "-16384",                    # AX AY AZ
        "120", "-80", "45",                                   # GX GY GZ
        str(mag), str(mag // 2), str(mag // 3),               # MX MY MZ
        str(int(4000 * math.sin(t * 0.9))),                   # МАХОВИК
        POST,
    ]
    if chaos and mk % 37 == 0:
        parts[4] = "OFF"       # СД2 отключён
    if chaos and mk % 53 == 0:
        parts[9] = "32767"     # AY насыщен
    return ";".join(parts)


class Handler(BaseHTTPRequestHandler):
    commands_open = False
    chaos = False

    def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # иначе пульт, открытый с файла или с другого порта, не прочитает ответ
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/telemetry":
            STATE["hits"] += 1
            if STATE["frame"] is None:
                self._send(204)
            else:
                self._send(200, STATE["frame"].encode("utf-8"))
            return
        if path == "/stats":
            # Счётчики для проверок: сколько запросов и сколько кадров
            body = 'hits=%d frames=%d mk=%d' % (
                STATE["hits"], STATE["frames"], STATE["mk"])
            self._send(200, body.encode("utf-8"))
            return
        if path == "/command":
            self._send(405 if self.commands_open else 404)
            return
        self._send(404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/command":
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            self._send(200 if self.commands_open else 404)
            return
        self._send(404)

    def log_message(self, *args) -> None:
        pass


def ticker(chaos: bool) -> None:
    """Кадры каждые 100 мс: счётчик МК растёт быстрее, чем успевает опрос."""
    while True:
        STATE["mk"] += 1
        STATE["frames"] += 1
        STATE["frame"] = make_frame(STATE["mk"], chaos)
        time.sleep(0.1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--commands", action="store_true", help="объявить канал команд открытым (405)")
    ap.add_argument("--chaos", action="store_true", help="периодически портить поля")
    args = ap.parse_args()

    Handler.commands_open = args.commands
    if not args.commands:
        STATE["frame"] = None

    import threading
    if not args.commands:
        threading.Thread(target=ticker, args=(args.chaos,), daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"эмулятор: http://127.0.0.1:{args.port}/telemetry"
          f"  команды: {'открыты' if args.commands else 'закрыты'}"
          f"  хаос: {'да' if args.chaos else 'нет'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())