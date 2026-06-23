"""Dogfood sample: clean Python that passes the strict ruff and pyright configs.

ci-workflows has no production Python; this minimal conforming module gives the
ruff and pyright actions real input to analyse against the vendored rulesets.
"""

from pathlib import Path


def count_lines(path: Path) -> int:
    """Return the number of lines in a UTF-8 text file."""
    with path.open(encoding="utf-8") as handle:
        return sum(1 for _ in handle)
