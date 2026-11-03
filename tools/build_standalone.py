#!/usr/bin/env python3
"""
Сборка всех файлов проекта в один самодостаточный HTML.

Проект статический: index.html + css/app.css + js/*.js. Скрипты подключены
обычными тегами <script src>, модулей и внешних зависимостей нет, поэтому
достаточно подставить содержимое по месту ссылок — порядок загрузки сохраняется.

Запуск:
    python3 tools/build_standalone.py              # -> dist/introsat-standalone.html
    python3 tools/build_standalone.py --no-readme  # без встроенного README
    python3 tools/build_standalone.py --out x.html --minify
"""

from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LINK_RE = re.compile(r'<link[^>]*\brel=["\']?stylesheet["\']?[^>]*>', re.I)
SCRIPT_RE = re.compile(
    r'<script\b(?P<attrs>[^>]*)\bsrc=["\'](?P<src>[^"\']+)["\'][^>]*>\s*</script>',
    re.I,
)
HREF_RE = re.compile(r'\bhref=["\']([^"\']+)["\']')


def guard(code: str, closer: str) -> str:
    """Защита от преждевременного закрытия тега, если код когда-нибудь его содержит."""
    return re.sub(re.escape(closer), r"<\/" + closer.lstrip("<"), code, flags=re.I)


def minify_css(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"\s*([{}:;,>])\s*", r"\1", css)
    css = re.sub(r";}", "}", css)
    return re.sub(r"\n+", "\n", css).strip()


def minify_js(js: str) -> str:
    """Очень консервативно: режем только заведомо безопасные полные комментарии."""
    js = re.sub(r"^\s*/\*(?!.*?\*/).*?\*/\s*$", "", js, flags=re.S | re.M)
    js = re.sub(r"^[ \t]*//[^\n]*\n", "", js, flags=re.M)
    return re.sub(r"\n{2,}", "\n", js).strip()


def build(readme: bool, out_path: Path, minify: bool) -> Path:
    html_src = (ROOT / "index.html").read_text(encoding="utf-8")

    # 1. CSS -> <style>
    def css_sub(m: re.Match[str]) -> str:
        href = HREF_RE.search(m.group(0))
        if not href:
            return m.group(0)
        css = (ROOT / href.group(1)).read_text(encoding="utf-8")
        if minify:
            css = minify_css(css)
        return f"<style>\n/* css/app.css */\n{guard(css, '</style')}\n</style>"

    html_out, n_css = LINK_RE.subn(css_sub, html_src, count=1)

    # 2. JS -> <script> по порядку появления в разметке
    def js_sub(m: re.Match[str]) -> str:
        attrs = m.group("attrs")
        js = (ROOT / m.group("src")).read_text(encoding="utf-8")
        if minify:
            js = minify_js(js)
        if 'type="module"' in attrs:
            attrs = attrs.replace('type="module"', "")
        return f"<script>\n/* js/{Path(m.group('src')).name} */\n{guard(js, '</script')}\n</script>"

    html_out, n_js = SCRIPT_RE.subn(js_sub, html_out)

    # 3. README -> раскрывающийся блок в конце страницы
    if readme:
        md = (ROOT / "README.md").read_text(encoding="utf-8")
        block = (
            '<details class="sheet__readme" id="readme">\n'
            "  <summary>Документация · README.md</summary>\n"
            f'  <pre class="raw">{html.escape(md)}</pre>\n'
            "</details>\n"
        )
        html_out = re.sub(r"</body>", block + "</body>", html_out, count=1)

    # 4. Баннер сборки
    banner = (
        '<!-- Собрано из index.html + css/app.css + js/{telemetry,analysis,views,app}.js'
        ' + README.md. Открывается двойным щелчком, сборка не требуется. -->\n'
    )
    html_out = html_out.replace("<!doctype html>", "<!doctype html>\n" + banner, 1)

    leftovers = []
    if LINK_RE.search(html_out):
        leftovers.append("остались <link rel=stylesheet>")
    if SCRIPT_RE.search(html_out):
        leftovers.append("остались <script src>")
    if re.search(r'(?:src|href)=["\'](?:css|js)/', html_out):
        leftovers.append("остались ссылки на css/ или js/")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_out, encoding="utf-8")

    print(f"CSS подключений встроено: {n_css}")
    print(f"JS модулей встроено:      {n_js}")
    print(f"README встроен:            {'да' if readme else 'нет'}")
    print(f"Размер исходников:        {sum(p.stat().st_size for p in [ROOT / 'index.html', ROOT / 'css/app.css', *sorted((ROOT / 'js').glob('*.js'))]) / 1024:.1f} КБ")
    print(f"Результат:                {out_path} ({out_path.stat().st_size / 1024:.1f} КБ)")
    if leftovers:
        print("ВНИМАНИЕ: " + "; ".join(leftovers), file=sys.stderr)
        return out_path
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist" / "introsat-standalone.html"))
    ap.add_argument("--no-readme", action="store_true")
    ap.add_argument("--minify", action="store_true")
    args = ap.parse_args()
    build(readme=not args.no_readme, out_path=Path(args.out).resolve(), minify=args.minify)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())