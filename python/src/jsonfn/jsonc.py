"""Convert JSONC source (line comments + trailing commas) to strict JSON.

Direct port of Go's ``StripJSONC``. Does NOT support block comments
(``/* ... */``) -- the conformance suite and example programs only use line
comments and trailing commas.
"""

from __future__ import annotations

import re

_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def strip_jsonc(src: str) -> str:
    """Strip ``//`` line comments (string-aware, with backslash escapes) and
    trailing commas before ``}`` or ``]``. Returns strict JSON suitable for
    ``json.loads``.
    """
    cleaned_lines: list[str] = []
    for line in src.split("\n"):
        in_string = False
        escaped = False
        cut = len(line)
        for j, ch in enumerate(line):
            if escaped:
                escaped = False
                continue
            if ch == "\\" and in_string:
                escaped = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if not in_string and ch == "/" and j + 1 < len(line) and line[j + 1] == "/":
                cut = j
                break
        cleaned_lines.append(line[:cut])
    joined = "\n".join(cleaned_lines)
    return _TRAILING_COMMA_RE.sub(r"\1", joined)
