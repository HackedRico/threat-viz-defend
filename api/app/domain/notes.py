import re
from collections import Counter
from collections.abc import Iterable

from app.domain.quiz import QuestionTopic, QuizQuestion, Result

# =============================================================================
# Module Overview
# =============================================================================
# What memory keeps about a developer, and what it reads back. `question_note`
# and `quiz_note` compose the notes Backboard stores after a question or a quiz
# answer: the board's title, the question, the quiz topic and the result, never
# uploads, map details or the developer's own answer text. `weak_topics` reads
# recalled notes back into the quiz topics the developer found hard, so the
# next quiz can start there. Memory may reword a note, so a note that no longer
# has the exact shape is read by the topic names and result words it contains.

# How each topic is named in a note; `_TOPIC_WORDS` finds these again in a reworded note.
TOPIC_NAMES: dict[QuestionTopic, str] = {
    "boundary": "trust boundaries",
    "data": "sensitive data",
    "threat": "where the system breaks",
    "stride": "STRIDE",
    "trifecta": "the lethal trifecta",
    "attack": "attack paths",
    "fix": "what to fix first",
}

_RESULT_WORDS: dict[Result, str] = {"correct": "right", "partial": "partly right", "wrong": "wrong"}

# Dict order is teaching order, which breaks ties between equally missed topics.
_TOPIC_WORDS: dict[QuestionTopic, re.Pattern[str]] = {
    "boundary": re.compile(r"trust[ -]?boundar", re.IGNORECASE),
    "data": re.compile(r"sensitive data", re.IGNORECASE),
    "threat": re.compile(r"where (?:the system|it) breaks", re.IGNORECASE),
    "stride": re.compile(r"\bstride\b", re.IGNORECASE),
    "trifecta": re.compile(r"trifecta", re.IGNORECASE),
    "attack": re.compile(r"attack paths?", re.IGNORECASE),
    "fix": re.compile(r"what to fix first|\bfix first\b", re.IGNORECASE),
}
_NAME_TOPIC = {name.lower(): topic for topic, name in TOPIC_NAMES.items()}
# A note in the shape `quiz_note` writes; its quoted question may itself say "wrong", so the result is read last.
_QUIZ_NOTE = re.compile(r'topic (?P<topic>[^:]+): they got ".*" (?P<result>right|partly right|wrong)\.$', re.DOTALL)
# How a reworded note says a question went badly; "partly right" counts, plain "right" does not.
_MISSED = re.compile(r"\b(?:wrong|partly|partial|partially|missed|incorrect|struggl\w*|mistak\w*)\b", re.IGNORECASE)

_TITLE_CHARS = 80
_TEXT_CHARS = 300


def question_note(board: str, question: str) -> str:
    """The note kept after the developer asks about a board: the board and their question."""
    return f'On the "{_clip(board, _TITLE_CHARS)}" board they asked: {_clip(question, _TEXT_CHARS)}'


def quiz_note(board: str, question: QuizQuestion, result: Result) -> str:
    """The note kept after a quiz answer: the board, the topic, the question and how it went."""
    return (
        f'Quiz on the "{_clip(board, _TITLE_CHARS)}" board, topic {TOPIC_NAMES[question.topic]}: '
        f'they got "{_clip(question.prompt, _TEXT_CHARS)}" {_RESULT_WORDS[result]}.'
    )


def weak_topics(notes: Iterable[str]) -> list[QuestionTopic]:
    """Quiz topics that recalled notes describe as missed, the most often missed first."""
    counts: Counter[QuestionTopic] = Counter()
    for note in notes:
        topics, missed = _read(note)
        if missed:
            counts.update(topics)
    order = list(_TOPIC_WORDS)
    return sorted(counts, key=lambda topic: (-counts[topic], order.index(topic)))


def notes_about(notes: Iterable[str], topics: Iterable[QuestionTopic]) -> list[str]:
    """The recalled notes that describe a miss on any of `topics`, in their recalled order."""
    wanted = set(topics)
    found: list[str] = []
    for note in notes:
        named, missed = _read(note)
        if missed and wanted.intersection(named):
            found.append(note)
    return found


def _read(note: str) -> tuple[list[QuestionTopic], bool]:
    """The topics a note is about and whether it describes a miss."""
    ours = _QUIZ_NOTE.search(note.strip())
    if ours is not None:
        topic = _NAME_TOPIC.get(ours["topic"].strip().lower())
        return ([topic] if topic else []), ours["result"] != "right"
    return [topic for topic, words in _TOPIC_WORDS.items() if words.search(note)], bool(_MISSED.search(note))


def _clip(text: str, limit: int) -> str:
    """One line of at most `limit` characters, so a note stays short and cannot pose as two notes."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 3].rstrip() + "..."
