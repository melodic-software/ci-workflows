"""Clean Python input for the Ruff and Pyright action contract fixtures."""

from pathlib import Path


def count_lines(path: Path) -> int:
    """Return the number of lines in a UTF-8 text file."""
    with path.open(encoding="utf-8") as handle:
        return sum(1 for _ in handle)
