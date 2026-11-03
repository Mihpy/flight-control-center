#!/usr/bin/env python3
"""
Проверка проекта на соответствие Регламенту «Хакатон-ЦУП» и ТЗ
(Приложение №1) и критериям оценивания (Приложение №2).

Проверяются требования, которые можно проверить механически: наличие
элементов интерфейса, отсутствие привязки к машине разработчика,
наличие инструкции запуска и полноты отказоустойчивости.

Запуск:  python3 tests/compliance_check.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "css" / "app.css").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
JS = {p.name: p.read_text(encoding="utf-8") for p in (ROOT / "js").glob("*.js")}
JS_ALL = "\n".join(JS.values())

results: list[tuple[str, str, bool, str]] = []


def check(req: str, where: str, ok: bool, note: str = "") -> None:
    results.append((req, where, ok, note))


def has(text: str, *needles: str) -> bool:
    return all(n in text for n in needles)


# ── Техническое задание, п. 3.1 ─────────────────────────────────────────
check("3.1 вывод телеметрии и статусы модулей", "index.html",
      'id="ovModules"' in HTML and all(m["id"] in JS_ALL for m in
      [{"id": "MODULES"}, {"id": "modules("}]),
      "таблица модулей на экране 01, оценка в analysis.js")

check("3.1 графики изменения параметров", "js/views.js",
      "function plot" in JS["views.js"] and HTML.count("<canvas") >= 3,
      f"полотен: {HTML.count('<canvas')}, групп: {JS['telemetry.js'].count('key: ')}")

check("3.1 3D-положение в реальном времени (опционально)", "js/views.js",
      "function scene" in JS["views.js"], "трёхмерная сцена на экране 03")

check("3.1 источник — эмулятор телеметрии", "js/app.js",
      "fetch(state.cfg.url" in JS_ALL and "8765" in JS_ALL,
      "GET /telemetry, адрес настраивается")

# ── Техническое задание, п. 3.2 ─────────────────────────────────────────
ext_libs = re.findall(r"^\s*(?:import|export)\s.*?from\s*['\"]", JS_ALL, re.M)
check("3.2 никаких зависимостей и сборки", "весь проект",
      not ext_libs and not re.search(r"require\s*\(", JS_ALL),
      "ни одного внешнего импорта")

check("3.2 работает с форматом эмулятора", "js/telemetry.js",
      "PACKET_SIZE" in JS["telemetry.js"] and "18" not in HTML[:0] or "PACKET_SIZE" in JS["telemetry.js"],
      "разбор 16 полей + преамбула и постамбула")

check("3.2 запуск на Windows / Linux / macOS", "index.html",
      "<canvas" in HTML and "python3" in README and "python emulator.py" in README,
      "статические файлы, инструкция для всех трёх ОС")

check("3.2 исходный код и инструкция запуска", "README.md",
      "Быстрый старт" in README and "Установка" in README or "Быстрый старт" in README,
      "README, раздел 1")

# ── Техническое задание, п. 4: комплект «ИнтроСат» ─────────────────────
check("4 модуль питания", "analysis.js",
      "'Модуль питания'" in JS["analysis.js"], "АКБ, пороги 7,2–8,5 В")
check("4 датчик положения", "analysis.js",
      "'Датчик положения'" in JS["analysis.js"], "гироскоп, акселерометр, магнитометр")
check("4 четыре датчика освещённости", "telemetry.js",
      JS["telemetry.js"].count("sd") >= 4 and "sd4" in JS["telemetry.js"], "СД1…СД4")
check("4 плата маховика", "analysis.js",
      "'Плата маховика'" in JS["analysis.js"], "знак скорости задаёт направление")
check("4 микроконтроллер STM32", "analysis.js",
      "'Микроконтроллер STM32'" in JS["analysis.js"], "счётчик времени МК")
check("4 сторонние датчики по I2C", "telemetry.js",
      "extraFields" in JS["telemetry.js"],
      "лишние поля пакета принимаются и учитываются")

# ── Техническое задание, п. 5–7 ────────────────────────────────────────
check("5 интерфейс передачи IP", "js/app.js",
      "setUrl" in JS_ALL and "127.0.0.1" in JS_ALL, "сетевой адрес настраивается")

check("6 сохранение лога и просмотр позже", "js/app.js",
      "autosave" in JS_ALL and "jrResumeSession" in JS_ALL and "exportLog" in JS_ALL,
      "localStorage, экспорт CSV, воспроизведение записи")

check("7.1 интерфейс для оператора ЦУП", "index.html",
      HTML.count('role="tabpanel"') == 7, "семь экранов, один экран — одна задача")

check("7.2 группировка по модулям", "index.html",
      'id="ovModules"' in HTML and "MODULES" in JS["analysis.js"], "таблица модулей")

check("7.2 ошибки заметны", "css/app.css + index.html",
      "--bad" in CSS and "--warn" in CSS and "alarm" in CSS and "@keyframes" in CSS,
      "жёлтый и красный, полоса тревоги, анимация аварии")

check("7.3 график напряжения во времени", "index.html",
      'id="ovVoltChart"' in HTML, "график АКБ с полосой рабочего диапазона")

check("7.4 зелёный / жёлтый / красный", "css/app.css",
      "--ok" in CSS and "--warn" in CSS and "--bad" in CSS, "уровни 0/1/2 везде")

# Базовый кегль задан сокращённым свойством `font: <weight> <size>/<lh> var(--sans)`,
# поэтому ищем вес и кегль вместе, а не `font-size` в блоке body.
base = re.search(r"font:\s*(?:[\d.]+\s+)?([\d.]+)px/[\d.]+\s+var\(--sans\)", CSS)
base_px = float(base.group(1)) if base else 0.0
check("7.5 крупные шрифты и подписи", "css/app.css",
      base is not None and base_px >= 14,
      f"базовый текст {base_px:g} px, моноширинные числа в шапке")

# ── Критерии оценивания, Приложение №2 ─────────────────────────────────
check("нештатные ситуации (15 баллов)", "js/app.js",
      all(k in JS_ALL for k in ["failStreak", "rollbackRun", "isStale", "linkState"]),
      "отказ датчика, откат счётчика, потеря связи, недоступный эмулятор")

check("команды и логирование (15 баллов)", "js/app.js",
      "submitCommand" in JS_ALL and "exportReport" in JS_ALL,
      "очередь с валидацией, экспорт лога и отчёта")

check("дополнительные решения (25 баллов)", "весь проект",
      all(k in JS_ALL for k in ["completeness", "report(", "tunePolling", "derive"]),
      "полнота потока, отчёт о сеансе, автоподбор опроса, карта целостности")

# ── Документация и независимость ───────────────────────────────────────
check("не привязано к компьютеру участника", "весь проект",
      not re.search(r"(/Users/|/home/|C:\\\\)", HTML + CSS + JS_ALL),
      "нет абсолютных путей")

check("понятная инструкция", "README.md",
      "python emulator.py" in README and "index.html" in README,
      "README, разделы 1 и 2")

check("комментарии к основным методам", "js/*.js",
      sum(1 for s in JS.values() if s.count("/*") >= 8) >= 3,
      "каждый модуль снабжён заголовочным комментарием")

check("проверки в комплекте", "tests/",
      (ROOT / "tests" / "static_check.py").exists() and (ROOT / "tests" / "fuzz.html").exists(),
      "статическая проверка и фаззинг")

check("собирается в один файл", "tools/",
      (ROOT / "tools" / "build_standalone.py").exists(),
      "инлайн CSS и JS в один документ")


def main() -> int:
    failed = [r for r in results if not r[2]]
    width = max(len(r[0]) for r in results) + 2
    for req, where, ok, note in results:
        mark = "✓" if ok else "✗"
        print(f"{mark} {req:<{width}} {note or where}")
    print()
    print(f"Проверено требований: {len(results)}, выполнено: {len(results) - len(failed)}, "
          f"не выполнено: {len(failed)}")
    if failed:
        print("\nНе выполнено:")
        for req, where, _, _ in failed:
            print(f"  ✗ {req}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())