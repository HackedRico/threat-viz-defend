import re
from typing import Protocol

from app.analysis import prompts
from app.domain.models import Answer, OpenGrade, SystemMap, ThreatAnalysis
from app.domain.quiz import QuizQuestion
from app.domain.rules import known_ids, label_of, only_known, sanitize_analysis, sanitize_map
from app.examples import find_example, load_examples
from app.llm.base import Llm, LlmError, LlmRequest
from app.memory import Memory

# =============================================================================
# Module Overview
# =============================================================================
# An `Analyst` performs the four model-backed steps: `draft_map`, `find_threats`,
# `answer` and `grade`. `LlmAnalyst` does them with a language model and runs
# every result through the rules' sanitizers, and with a `Memory` it recalls
# and keeps notes around `answer` and `grade`. `DemoAnalyst` needs no model: it
# replays the built-in examples and grades open answers by keyword, so the app
# runs, and tests pass, without an API key.


class Analyst(Protocol):
    """The model-backed analysis steps, whatever does the work behind them."""

    @property
    def label(self) -> str:
        """What produced the analysis, as shown to users."""
        ...

    def draft_map(self, material: str, current: SystemMap | None) -> SystemMap:
        """Draw a data flow map from `material`, refining `current` when there is one."""
        ...

    def find_threats(self, system: SystemMap) -> ThreatAnalysis:
        """Find threats and attack paths on a confirmed map."""
        ...

    def answer(self, system: SystemMap, analysis: ThreatAnalysis, question: str, focus: str | None) -> Answer:
        """Answer a question about a finished board."""
        ...

    def grade(self, system: SystemMap, analysis: ThreatAnalysis | None, question: QuizQuestion, text: str) -> OpenGrade:
        """Grade a developer's own-words answer to an open quiz question."""
        ...


# =============================================================================
# Model-backed analyst
# =============================================================================


class LlmAnalyst:
    """An `Analyst` that asks a language model and sanitizes every reply."""

    def __init__(self, llm: Llm, memory: Memory | None = None) -> None:
        self._llm = llm
        self._memory = memory

    @property
    def label(self) -> str:
        """The provider and model behind this analyst."""
        return self._llm.label

    def draft_map(self, material: str, current: SystemMap | None) -> SystemMap:
        """Draw or update a map, then repair ids and drop broken references."""
        system = self._llm.generate(
            LlmRequest("draft_map", prompts.DRAFT_MAP_SYSTEM, prompts.draft_map_content(material, current), SystemMap)
        )
        return _require_nodes(sanitize_map(system), self.label)

    def find_threats(self, system: SystemMap) -> ThreatAnalysis:
        """Find threats, then drop any pinned to an element the map lacks."""
        analysis = self._llm.generate(
            LlmRequest(
                "find_threats", prompts.FIND_THREATS_SYSTEM, prompts.find_threats_content(system), ThreatAnalysis
            )
        )
        return sanitize_analysis(system, analysis)

    def answer(self, system: SystemMap, analysis: ThreatAnalysis, question: str, focus: str | None) -> Answer:
        """Answer a question, keeping only highlights that exist on the board."""
        notes = self._memory.recall(question) if self._memory else []
        reply = self._llm.generate(
            LlmRequest(
                "answer",
                prompts.ANSWER_SYSTEM,
                prompts.answer_content(system, analysis, question, focus, notes),
                Answer,
            )
        )
        if self._memory:
            self._memory.keep(f"Asked about their threat model: {question}")
        return Answer(answer=reply.answer, highlight=only_known(reply.highlight, known_ids(system, analysis)))

    def grade(self, system: SystemMap, analysis: ThreatAnalysis | None, question: QuizQuestion, text: str) -> OpenGrade:
        """Grade an open answer, keeping only highlights that exist on the board."""
        notes = self._memory.recall(question.prompt) if self._memory else []
        grade = self._llm.generate(
            LlmRequest(
                "grade", prompts.GRADE_SYSTEM, prompts.grade_content(system, analysis, question, text, notes), OpenGrade
            )
        )
        if self._memory:
            # The question and verdict only: the developer's own words stay out of memory.
            self._memory.keep(f"Quiz question: {question.prompt} Their answer was graded {grade.verdict}.")
        return grade.model_copy(update={"highlight": only_known(grade.highlight, known_ids(system, analysis))})


def _require_nodes(system: SystemMap, label: str) -> SystemMap:
    """Reject a map with nothing on it, which means the material described no system."""
    if not system.nodes:
        raise LlmError(
            "bad_output",
            f"{label} found no components in that material. Add design notes, a README or source code, and try again.",
        )
    return system


# =============================================================================
# Demo analyst: no model, built-in examples only
# =============================================================================

_WORD = re.compile(r"[a-z0-9_]+")


class DemoAnalyst:
    """An `Analyst` that replays the built-in examples and grades by keyword."""

    label = "Demo mode (built-in example only)"

    def draft_map(self, material: str, current: SystemMap | None) -> SystemMap:
        """Return the example map whose material was pasted, or explain that demo mode knows only the examples."""
        example = find_example(material)
        if example is None:
            titles = ", ".join(e.title for e in load_examples())
            raise LlmError(
                "not_configured",
                f"Demo mode can only map the built-in examples ({titles}). "
                "Set `LLM_API_KEY` and `LLM_MODEL` on the server to map your own system.",
            )
        return example.map

    def find_threats(self, system: SystemMap) -> ThreatAnalysis:
        """Return the example analysis for a map drawn from an example, trimmed to what is still on it."""
        example = next((e for e in load_examples() if e.map.name == system.name), None)
        if example is None:
            raise LlmError(
                "not_configured",
                "Demo mode can only find threats on the built-in examples. Set `LLM_API_KEY` and `LLM_MODEL`.",
            )
        return sanitize_analysis(system, example.analysis)

    def answer(self, system: SystemMap, analysis: ThreatAnalysis, question: str, focus: str | None) -> Answer:
        """Return a recorded answer when the question matches one, or point at the questions demo mode knows."""
        wanted = _words(question)
        for example in load_examples():
            for recorded, reply in example.answers.items():
                if _words(recorded) == wanted:
                    return Answer(
                        answer=reply.answer, highlight=only_known(reply.highlight, known_ids(system, analysis))
                    )
        known = [q for e in load_examples() if e.map.name == system.name for q in e.answers]
        hint = f' Try: "{known[0]}"' if known else ""
        return Answer(answer=f"Demo mode only knows recorded questions.{hint}", highlight=[])

    def grade(self, system: SystemMap, analysis: ThreatAnalysis | None, question: QuizQuestion, text: str) -> OpenGrade:
        """Grade by how many expected elements the answer names, which is crude but needs no model."""
        said = _words(text)
        named = [item for item in question.expected if _words(label_of(system, analysis, item)) & said]
        fixes = [fix for fix in question.rubric if len(_words(fix) & said) >= 2]
        share = len(named) / len(question.expected) if question.expected else 0.0
        if share >= 0.4 or (named and fixes):
            verdict: str = "solid"
        elif named or fixes:
            verdict = "partial"
        else:
            verdict = "missed"
        missing = [label_of(system, analysis, i) for i in question.expected if i not in named][:3]
        feedback = (
            f"You named {', '.join(label_of(system, analysis, i) for i in named) or 'none of the key parts'}."
            + (f" A complete answer also covers {', '.join(missing)}." if missing else "")
            + " (Demo mode grades by keyword.)"
        )
        return OpenGrade.model_validate({"verdict": verdict, "feedback": feedback, "highlight": question.expected})


def _words(text: str) -> set[str]:
    """Lowercase words of three letters or more, for loose matching."""
    return {w for w in _WORD.findall(text.lower()) if len(w) >= 3}
