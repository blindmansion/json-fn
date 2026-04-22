"""Parse and walk `$var` paths like ``"data.items[0].name"``.

The parser is identical in semantics to the Go and TypeScript implementations:

    - First segment (before the first ``.`` or ``[``) is the variable name.
    - ``.key`` accesses a string property.
    - ``[N]`` accesses a numeric index when ``N`` is a strict integer literal,
      otherwise a string key.
    - Empty segments and unclosed brackets raise :class:`PathError`.

Results are cached via :func:`functools.lru_cache` to amortize parsing cost
in hot loops; the segments tuple makes the result hashable and immutable.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from .errors import PathError

PathSegments = tuple[str | int, ...]


@lru_cache(maxsize=1024)
def parse_path(s: str) -> tuple[str, PathSegments]:
    """Parse a ``$var`` path string into ``(variable_name, segments_tuple)``.

    ``"foo"``                -> ``("foo", ())``
    ``"foo.bar"``            -> ``("foo", ("bar",))``
    ``"foo[0]"``             -> ``("foo", (0,))``
    ``"data.items[1].name"`` -> ``("data", ("items", 1, "name"))``
    """

    dot_idx = s.find(".")
    bracket_idx = s.find("[")

    if dot_idx == -1 and bracket_idx == -1:
        return s, ()

    if dot_idx == -1:
        split_idx = bracket_idx
    elif bracket_idx == -1:
        split_idx = dot_idx
    else:
        split_idx = min(dot_idx, bracket_idx)

    variable = s[:split_idx]
    if not variable:
        raise PathError(f'Invalid $var path: variable name cannot be empty in "{s}"')

    segments: list[str | int] = []
    i = split_idx
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == ".":
            i += 1
            end = i
            while end < n and s[end] not in (".", "["):
                end += 1
            if end == i:
                raise PathError(f'Invalid $var path: empty segment after "." in "{s}"')
            segments.append(s[i:end])
            i = end
        elif ch == "[":
            i += 1
            close_idx = s.find("]", i)
            if close_idx == -1:
                raise PathError(f'Invalid $var path: unclosed "[" in "{s}"')
            inner = s[i:close_idx]
            if not inner:
                raise PathError(f'Invalid $var path: empty "[]" in "{s}"')
            # Strict integer literal? "0", "12", "-3" all OK; "01" is not strict.
            if _is_strict_int(inner):
                segments.append(int(inner))
            else:
                segments.append(inner)
            i = close_idx + 1
        else:
            raise PathError(f'Invalid $var path: unexpected character "{ch}" in "{s}"')

    return variable, tuple(segments)


def _is_strict_int(s: str) -> bool:
    """Return True iff ``s`` is the canonical string form of an int.

    Matches Go's ``strconv.Atoi(s) ; strconv.Itoa(n) == s`` round-trip.
    """
    try:
        n = int(s)
    except ValueError:
        return False
    return str(n) == s


def walk_path(value: Any, segments: PathSegments) -> Any:
    """Resolve ``segments`` against ``value``. Returns ``None`` for any
    missing key, out-of-range index, or type mismatch (string-with-string-key,
    list-with-string-key, etc.) — matching Go's ``walkPath``.
    """
    current = value
    for seg in segments:
        if current is None:
            return None
        if isinstance(current, (str, list)):
            if isinstance(seg, int):
                if 0 <= seg < len(current):
                    current = current[seg]
                else:
                    return None
            else:
                return None
        elif isinstance(current, dict):
            if isinstance(seg, str):
                if seg in current:
                    current = current[seg]
                else:
                    return None
            else:
                return None
        else:
            return None
    return current
