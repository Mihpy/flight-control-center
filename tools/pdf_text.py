#!/usr/bin/env python3
"""
Извлечение текста из PDF без внешних библиотек.

Нужен для чтения регламента: инструмент чтения файлов PDF не поддерживает,
а полноценный парсер ставить незачем. Решает простой случай: потоки
FlateDecode, текст операторами Tj/TJ, зачастую с кириллицей в WinAnsi.

Запуск:  python3 tools/pdf_text.py путь-к.pdf [страницы]
"""

from __future__ import annotations

import re
import sys
import zlib
from pathlib import Path


def streams(data: bytes) -> list[bytes]:
    out = []
    for match in re.finditer(rb"stream\r?\n", data):
        start = match.end()
        end = data.find(b"endstream", start)
        if end < 0:
            continue
        raw = data[start:end]
        try:
            out.append(zlib.decompress(raw))
        except zlib.error:
            try:
                out.append(zlib.decompressobj().decompress(raw))
            except zlib.error:
                out.append(raw)
    return out


def text_of(content: bytes) -> str:
    """Собирает текст из операторов Tj/TJ/'/" с учётом переводов строк."""
    chunks: list[str] = []
    # литеральные строки в операторах
    for match in re.finditer(rb"\((?:\\.|[^()\\])*\)", content, re.S):
        raw = match.group(0)[1:-1]
        raw = re.sub(rb"\\([()\\])", rb"\1", raw)
        raw = re.sub(rb"\\([0-7]{1,3})", lambda m: bytes([int(m.group(1), 8) & 0xFF]), raw)
        chunks.append(raw.decode("latin-1"))
    text = " ".join(chunks)
    # шестнадцатеричные строки <....> — на случай CID-шрифтов
    if len(text.strip()) < 40:
        hexed = " ".join(
            bytes.fromhex(h.decode()).decode("latin-1")
            for h in re.findall(rb"<([0-9A-Fa-f]{4,})>", content)
        )
        text = hexed or text
    text = text.replace("\x00", "")
    return text


def main() -> int:
    path = Path(sys.argv[1])
    data = path.read_bytes()
    found = False
    for index, content in enumerate(streams(data), 1):
        if b"Tj" not in content and b"TJ" not in content:
            continue
        found = True
        body = text_of(content)
        if not body.strip():
            continue
        print(f"\n──────── поток {index} ────────")
        print(body)
    if not found:
        print("Текстовых потоков не найдено — возможно, документ состоит из изображений.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())