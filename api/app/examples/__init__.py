import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from pydantic import BaseModel, ValidationError

from app.domain.models import Answer, SystemMap, ThreatAnalysis
from app.domain.rules import sanitize_analysis, sanitize_map

# =============================================================================
# Module Overview
# =============================================================================
# Built-in example boards, kept as data: each folder under this package holds
# `material.md`, the design notes a user would paste, and `board.json`, the map,
# analysis and canned answers. `load_examples` validates them all at startup, so
# a broken example stops the server instead of reaching a user.

EXAMPLES_DIR = Path(__file__).parent


class _ExampleFile(BaseModel):
    """The shape of `board.json`."""

    title: str
    map: SystemMap
    analysis: ThreatAnalysis
    questions: dict[str, Answer]


@dataclass(frozen=True)
class Example:
    """One built-in example board."""

    key: str
    title: str
    material: str
    map: SystemMap
    analysis: ThreatAnalysis
    answers: dict[str, Answer]


@cache
def load_examples(root: Path = EXAMPLES_DIR) -> tuple[Example, ...]:
    """Load and validate every example folder under `root`, in name order."""
    examples: list[Example] = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        board_path = folder / "board.json"
        try:
            data = _ExampleFile.model_validate(json.loads(board_path.read_text(encoding="utf-8")))
        except (OSError, ValueError, ValidationError) as exc:
            raise ValueError(f"Example `{folder.name}` is broken: fix `{board_path}`.") from exc
        # An example must already be what the sanitizers would produce, or ids in it would dangle.
        if sanitize_map(data.map) != data.map or sanitize_analysis(data.map, data.analysis) != data.analysis:
            raise ValueError(
                f"Example `{folder.name}` has ids the rules would change: check every reference in `{board_path}`."
            )
        examples.append(
            Example(
                key=folder.name,
                title=data.title,
                material=(folder / "material.md").read_text(encoding="utf-8"),
                map=data.map,
                analysis=data.analysis,
                answers=data.questions,
            )
        )
    return tuple(examples)


def find_example(material: str) -> Example | None:
    """The example whose material matches `material`, ignoring surrounding whitespace."""
    wanted = " ".join(material.split())
    return next((ex for ex in load_examples() if " ".join(ex.material.split()) in wanted), None)
