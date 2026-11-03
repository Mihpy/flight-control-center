#!/usr/bin/env python3
"""
Единая точка запуска проверок проекта.

    python3 tests/run_all.py            статика + сборка + краткий отчёт
    python3 tests/run_all.py --fuzz N  дополнительно N итераций фаззинга
    python3 tests/run_all.py --full     полный прогон интерфейса (долго)

Статическая часть не требует браузера. Фаззинг запускается в headless-браузере
агента через tests/fuzz.html и tests/ui_fuzz.html; здесь он лишь выводит адреса,
если сервер не поднят.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
PORT = 8779


def step(title: str) -> None:
    print(f"\n{'=' * 66}\n{title}\n{'=' * 66}")


def compliance() -> int:
    step("2. Соответствие регламенту и ТЗ")
    proc = subprocess.run([sys.executable, str(TESTS / "compliance_check.py")],
                          capture_output=True, text=True, cwd=ROOT)
    lines = proc.stdout.strip().splitlines()
    print("\n".join(lines[-3:] if len(lines) > 3 else lines))
    failed = [l for l in lines if l.startswith("  ✗")]
    if failed:
        print("\n".join(failed))
    return proc.returncode


def static() -> int:
    step("1. Статическая проверка (разметка ↔ код ↔ стили)")
    proc = subprocess.run([sys.executable, str(TESTS / "static_check.py")],
                          capture_output=True, text=True, cwd=ROOT)
    print(proc.stdout.strip() or proc.stderr.strip())
    return proc.returncode


def build() -> int:
    step("3. Сборка одного файла")
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "build_standalone.py")],
                          capture_output=True, text=True, cwd=ROOT)
    print(proc.stdout.strip() or proc.stderr.strip())
    return proc.returncode


def syntax() -> int:
    step("4. Проверка синтаксиса скриптов")
    ok = True
    for name in ("telemetry.js", "analysis.js", "views.js", "app.js"):
        src = (ROOT / "js" / name).read_text(encoding="utf-8")
        balance = src.count("{") - src.count("}")
        parens = src.count("(") - src.count(")")
        status = "ок" if balance == 0 and parens == 0 else f"ДИСБАЛАНС {{}}={balance} ()={parens}"
        if status != "ок":
            ok = False
        print(f"  {name:16} {status}")
    return 0 if ok else 1


def server_up() -> bool:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/tests/fuzz.html", timeout=1).read(1)
        return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fuzz", type=int, default=0, help="итераций фаззинга разбора")
    ap.add_argument("--full", action="store_true", help="полный прогон интерфейса")
    args = ap.parse_args()

    codes = [syntax(), static(), compliance(), build()]

    if args.fuzz or args.full:
        step("5. Фаззинг")
        if server_up():
            print(f"  Сервер найден на порту {PORT}: откройте")
            print(f"    http://127.0.0.1:{PORT}/tests/fuzz.html")
            print(f"  и вызовите в консоли:  runFuzz({args.fuzz or 1000}, 42)")
            if args.full:
                print(f"    http://127.0.0.1:{PORT}/tests/ui_fuzz.html?n=300&seed=7")
        else:
            print(f"  Поднимите сервер:  python3 tests/serve.py {PORT}")
    else:
        step("5. Фаззинг")
        print("  Пропущен. Запустить: python3 tests/serve.py 8779,")
        print("  затем открыть tests/fuzz.html и вызвать runFuzz(1000, 42).")

    step("Итог")
    print("  Проверок с ошибками:", sum(1 for c in codes if c))
    return max(codes)


if __name__ == "__main__":
    raise SystemExit(main())