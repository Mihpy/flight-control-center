#!/usr/bin/env python3
"""
Статическая проверка проекта: перекрёстные ссылки разметки и кода.

Никаких внешних инструментов — только то, что есть в стандартной библиотеке.
Запуск:  python3 tests/static_check.py
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
CSS = ROOT / "css" / "app.css"
JS = [ROOT / "js" / n for n in ("telemetry.js", "analysis.js", "views.js", "app.js")]

problems: list[tuple[str, str]] = []


def add(kind: str, detail: str) -> None:
    problems.append((kind, detail))


def main() -> int:
    html = HTML.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    js_all = "\n".join(p.read_text(encoding="utf-8") for p in JS)
    js_map = {p.name: p.read_text(encoding="utf-8") for p in JS}

    # ── 1. Идентификаторы разметки ─────────────────────────────────────────
    html_ids = re.findall(r'\sid="([^"]+)"', html)
    dupes = [i for i, n in Counter(html_ids).items() if n > 1]
    for i in dupes:
        add("ДУБЛЬ ID", f'<div id="{i}"> встречается в разметке несколько раз')

    # ── 2. Ссылки из JS на элементы DOM ────────────────────────────────────
    referenced: set[str] = set()
    for name, src in js_map.items():
        for pattern in (r"""\$\(\s*['"]#([A-Za-z][\w-]*)['"]""",
                        r"""\$\$\(\s*['"]#([A-Za-z][\w-]*)\s""",
                        r"""getElementById\(\s*['"]([A-Za-z][\w-]*)['"]""",
                        r"""querySelector\(\s*['"]#([A-Za-z][\w-]*)['"]"""):
            for ref in re.findall(pattern, src):
                referenced.add(ref)
                if ref not in html_ids:
                    add("НЕТ ЭЛЕМЕНТА", f"{name}: ссылка на #{ref}, которого нет в index.html")

    # Динамически адресуемые элементы: $('#' + id) из таблиц соответствия
    dynamic_ids: set[str] = set()
    for name, src in js_map.items():
        for block in re.findall(r"const map = \{(.*?)\};", src, re.S):
            dynamic_ids.update(re.findall(r"(\w+):\s*'\w+'", block))
    # Цели для доступности и якоря тоже считаются использованными
    a11y_ids: set[str] = set()
    for attr in ("for", "aria-controls", "aria-describedby", "aria-labelledby"):
        for ref in re.findall(attr + r'="([^"]+)"', html):
            a11y_ids.update(ref.split())
    a11y_ids.update(re.findall(r'href="#([^"]+)"', html))

    unused_ids = [i for i in html_ids
                  if i not in referenced and i not in dynamic_ids and i not in a11y_ids
                  and not i.startswith(("view-", "tab-"))]
    for i in unused_ids:
        add("ID НЕ ИСПОЛЬЗУЕТСЯ", f'id="{i}" — в разметке есть, в JS не упоминается')

    # ── 3. Доступность: label/for, aria-controls, aria-describedby ─────────
    for attr, target in (("for", r'<label[^>]*\bfor="([^"]+)"'),
                         ("aria-controls", r'aria-controls="([^"]+)"'),
                         ("aria-describedby", r'aria-describedby="([^"]+)"'),
                         ("aria-labelledby", r'aria-labelledby="([^"]+)"')):
        for ref in re.findall(target, html):
            for one in ref.split():
                if one not in html_ids:
                    add("A11Y", f'{attr}="{one}" — цель не существует')

    # ── 4. Внутренние якоря ────────────────────────────────────────────────
    for anchor in re.findall(r'href="#([^"]+)"', html):
        if anchor and anchor not in html_ids:
            add("ССЫЛКА", f'href="#{anchor}" — якоря нет в разметке')

    # ── 5. Классы из разметки, которых нет в CSS ───────────────────────────
    used_classes: set[str] = set()
    for attr in re.findall(r'\sclass="([^"]+)"', html):
        used_classes.update(c for c in attr.split() if c)
    for name, src in js_map.items():
        for attr in re.findall(r"""class="([^"$']+)""", src):
            used_classes.update(c for c in attr.split() if c and not c.startswith("{"))
    defined = set(re.findall(r"\.([A-Za-z][\w-]*)", css))
    for cls in sorted(used_classes - defined):
        add("КЛАСС БЕЗ СТИЛЯ", f".{cls} — используется в разметке, но не описан в app.css")

    # ── 6. CSS: переменные читаются кодом, но не объявлены ────────────────
    declared = set(re.findall(r"(--[a-z0-9-]+)\s*:", css))
    for name, src in js_map.items():
        for var in set(re.findall(r"var\(\s*(--[a-z0-9-]{2,})", src)) | set(re.findall(r"read\(\s*['\"](--[a-z0-9-]+)", src)):
            if var not in declared:
                add("НЕТ ПЕРЕМЕННОЙ", f"{name}: {var} используется, но не объявлена в app.css")

    # ── 7. Мёртвый код: экспортируется, но нигде не читается ──────────────
    for name, src in js_map.items():
        if name == "app.js":
            continue
        for symbol in re.findall(r"^\s*([A-Za-z_$][\w$]*),\s*$", src, re.M):
            uses = len(re.findall(rf"(?<![.\w$]){re.escape(symbol)}\b", js_all))
            if uses <= 1:
                add("МЁРТВЫЙ КОД", f"{name}: «{symbol}» экспортируется, но нигде не используется")

    # ── 8. Опасные приёмы ─────────────────────────────────────────────────
    for name, src in js_map.items():
        for i, line in enumerate(src.splitlines(), 1):
            code = re.sub(r"//.*$|/\*.*?\*/", "", line)
            if re.search(r"(?<![=!<>])==(?![=])", code):
                add("== ВМЕСТО ===", f"{name}:{i}: {line.strip()[:90]}")
            if re.search(r"\bvar\s+[A-Za-z_$]", code):
                add("var", f"{name}:{i}: {line.strip()[:90]}")

    # 8b. Сырые данные пакета не должны попадать в разметку без экранирования
    raw_sources = ("frame.raw", "entry.raw", "item.sample", "item.reason",
                   "item.detail", "event.msg", "entry.msg", "file.name", "label")
    for name, src in js_map.items():
        for i, line in enumerate(src.splitlines(), 1):
            if "innerHTML" not in line:
                continue
            # многострочные присваивания собираются в одну логическую строку
            if not any(token in line for token in raw_sources):
                continue
            window = " ".join(src.splitlines()[max(0, i - 4):i])
            if "escapeHtml" in window:
                continue
            add("ЭКРАНИРОВАНИЕ", f"{name}:{i}: сырые данные попадают в innerHTML — {line.strip()[:80]}")
        if re.search(r"\beval\s*\(|new Function\s*\(", src):
            add("БЕЗОПАСНОСТЬ", f"{name}: используется eval / new Function")

    # ── 9. Баланс тегов ───────────────────────────────────────────────────
    void = {"meta", "link", "br", "hr", "img", "input", "source", "path", "circle", "rect"}
    stack: list[str] = []
    for tag in re.findall(r"<(/?)([a-zA-Z][\w-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(/?)>", html):
        closing, name, attrs, self_close = tag
        low = name.lower()
        if low in void or self_close:
            continue
        if closing:
            if stack and stack[-1] == low:
                stack.pop()
            elif low in stack:
                while stack and stack[-1] != low:
                    add("HTML", f"не закрыт <{stack.pop()}> внутри </{low}>")
                stack.pop()
        else:
            stack.append(low)
    for leftover in stack:
        add("HTML", f"тег <{leftover}> не закрыт до конца файла")

    # ── Итог ──────────────────────────────────────────────────────────────
    if not problems:
        print("Замечаний нет.")
        return 0
    grouped: dict[str, list[str]] = {}
    for kind, detail in problems:
        grouped.setdefault(kind, []).append(detail)
    for kind in sorted(grouped, key=lambda k: -len(grouped[k])):
        print(f"\n## {kind} ({len(grouped[kind])})")
        for detail in grouped[kind]:
            print("  - " + detail)

    # Найденные классы без правил — не дефект: крючок элемента оставляют
    # осмысленно, под будущее оформление. Ошибкой считается остальное.
    informational = {"КЛАСС БЕЗ СТИЛЯ"}
    errors = [(k, d) for k, d in problems if k not in informational]
    print(f"\nЗамечаний всего: {len(problems)}, из них ошибок: {len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())