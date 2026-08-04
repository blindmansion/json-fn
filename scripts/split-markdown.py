#!/usr/bin/env python3
"""Split a Markdown document at headings and repair its relative links."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
LINK_RE = re.compile(r"(\]\()([^)]+)(\))")


def filename_slug(title: str) -> str:
    """Create a readable default filename from a heading."""
    title = re.sub(r"<[^>]+>", "", title)
    title = re.sub(r"[`*_~]", "", title).strip().lower()
    title = re.sub(r"[^\w\s-]", "", title)
    return re.sub(r"[\s-]+", "-", title).strip("-")


def heading_slug(title: str) -> str:
    """Approximate GitHub's generated Markdown heading IDs."""
    title = re.sub(r"<[^>]+>", "", title)
    title = re.sub(
        r"`([^`]*)`",
        lambda match: match.group(1).strip().strip("{}").strip(),
        title,
    )
    title = re.sub(r"[*_~]", "", title).lower()
    title = re.sub(r"[^\w\s-]", "", title).strip()
    return re.sub(r"\s", "-", title)


def parse_names(values: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"--name must be HEADING=FILENAME, got {value!r}")
        heading, filename = value.split("=", 1)
        if not filename.endswith(".md") or Path(filename).name != filename:
            raise ValueError(f"filename must be a plain .md filename, got {filename!r}")
        names[heading] = filename
    return names


def split_sections(lines: list[str], level: int) -> tuple[list[str], list[tuple[str, list[str]]]]:
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    current_title: str | None = None
    current_lines: list[str] = []
    marker = "#" * level

    for line in lines:
        match = HEADING_RE.match(line)
        if match and match.group(1) == marker:
            if current_title is not None:
                sections.append((current_title, current_lines))
            current_title = match.group(2)
            current_lines = [line]
        elif current_title is None:
            preamble.append(line)
        else:
            current_lines.append(line)

    if current_title is not None:
        sections.append((current_title, current_lines))
    if not sections:
        raise ValueError(f"no level-{level} headings found")
    return preamble, sections


def heading_destinations(
    preamble: list[str],
    sections: list[tuple[str, list[str]]],
    filenames: dict[str, str],
) -> dict[str, tuple[str, str]]:
    destinations: dict[str, tuple[str, str]] = {}
    source_seen: dict[str, int] = {}

    for filename, lines in [("index.md", preamble), *[(filenames[title], body) for title, body in sections]]:
        output_seen: dict[str, int] = {}
        for line in lines:
            match = HEADING_RE.match(line)
            if not match:
                continue
            base = heading_slug(match.group(2))
            source_occurrence = source_seen.get(base, 0)
            source_seen[base] = source_occurrence + 1
            source_anchor = base if source_occurrence == 0 else f"{base}-{source_occurrence}"

            output_occurrence = output_seen.get(base, 0)
            output_seen[base] = output_occurrence + 1
            output_anchor = base if output_occurrence == 0 else f"{base}-{output_occurrence}"
            destinations[source_anchor] = (filename, output_anchor)
    return destinations


def rewrite_links(
    text: str,
    source_dir: Path,
    output_dir: Path,
    current_file: str,
    destinations: dict[str, tuple[str, str]],
) -> str:
    def replace(match: re.Match[str]) -> str:
        target = match.group(2)
        if target.startswith("#"):
            anchor = target[1:]
            destination = destinations.get(anchor)
            if destination is None:
                rewritten = target
            else:
                filename, output_anchor = destination
                if filename == current_file:
                    rewritten = f"#{output_anchor}"
                else:
                    rewritten = f"{filename}#{output_anchor}"
            return f"{match.group(1)}{rewritten}{match.group(3)}"

        path_text, separator, fragment = target.partition("#")
        if (
            not path_text
            or path_text.startswith(("/", "mailto:"))
            or re.match(r"^[a-z][a-z0-9+.-]*:", path_text, re.IGNORECASE)
        ):
            return match.group(0)

        absolute_target = (source_dir / path_text).resolve()
        rewritten_path = os.path.relpath(absolute_target, output_dir)
        rewritten = rewritten_path + (separator + fragment if separator else "")
        return f"{match.group(1)}{rewritten}{match.group(3)}"

    return LINK_RE.sub(replace, text)


def promote_headings(lines: list[str], amount: int) -> list[str]:
    promoted: list[str] = []
    for line in lines:
        match = HEADING_RE.match(line)
        if match:
            new_level = max(1, len(match.group(1)) - amount)
            line = f"{'#' * new_level} {match.group(2)}\n"
        promoted.append(line)
    return promoted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--level", type=int, default=2)
    parser.add_argument(
        "--name",
        action="append",
        default=[],
        metavar="HEADING=FILENAME",
        help="manually choose a filename for a split section",
    )
    parser.add_argument("--remove-source", action="store_true")
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    manual_names = parse_names(args.name)
    preamble, sections = split_sections(source.read_text().splitlines(keepends=True), args.level)

    titles = {title for title, _ in sections}
    unknown_names = manual_names.keys() - titles
    if unknown_names:
        raise ValueError(f"--name headings not found: {sorted(unknown_names)}")

    filenames = {
        title: manual_names.get(title, f"{filename_slug(title)}.md") for title, _ in sections
    }
    if len(set(filenames.values())) != len(filenames):
        raise ValueError("section filenames must be unique")

    destinations = heading_destinations(preamble, sections, filenames)
    output.mkdir(parents=True, exist_ok=False)

    contents = ["\n", "## Contents\n", "\n"]
    contents.extend(f"- [{title}]({filenames[title]})\n" for title, _ in sections)
    index_text = rewrite_links(
        "".join(preamble), source.parent, output, "index.md", destinations
    )
    index_text += "".join(contents)
    (output / "index.md").write_text(index_text)

    for title, lines in sections:
        filename = filenames[title]
        text = "".join(promote_headings(lines, args.level - 1))
        text = rewrite_links(text, source.parent, output, filename, destinations)
        (output / filename).write_text(text)

    if args.remove_source:
        source.unlink()


if __name__ == "__main__":
    main()
