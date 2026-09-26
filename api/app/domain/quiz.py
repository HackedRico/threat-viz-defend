from collections.abc import Iterable, Sequence
from typing import Literal

from pydantic import BaseModel

from app.domain.models import Flow, Node, SystemMap, Threat, ThreatAnalysis
from app.domain.rules import (
    STRIDE,
    ai_exposure,
    crosses_boundary,
    flow_label,
    label_of,
    node_index,
    remove_element,
    severity_rank,
)

# =============================================================================
# Module Overview
# =============================================================================
# The whiteboard defense: questions a developer should be able to answer about
# the system they shipped. `build_quiz` works out every answer key from the map
# and the rules, never from a model, and `grade_choice` grades picked options by
# code. Only the open questions, answered in the developer's own words, go to a
# model for grading, against the `expected` ids and `rubric` set here.

QuestionTopic = Literal["boundary", "data", "threat", "stride", "trifecta", "attack", "fix"]
QuestionKind = Literal["single", "multi", "open"]
Result = Literal["correct", "partial", "wrong"]

MAX_OPTIONS = 5


class QuizOption(BaseModel):
    """One choice, keyed by the element id or STRIDE letter it stands for."""

    id: str
    label: str


class QuizEvidence(BaseModel):
    """Where part of an answer comes from: an element and what the material said about it."""

    id: str
    label: str
    evidence: str


class QuizQuestion(BaseModel):
    """One question, with its answer key worked out by code."""

    id: str
    topic: QuestionTopic
    kind: QuestionKind
    prompt: str
    options: list[QuizOption]
    # Option ids that make the right answer; empty for open questions.
    answer: list[str]
    # Ids a complete open answer touches; empty for choice questions.
    expected: list[str]
    # Points a complete open answer makes; empty for choice questions.
    rubric: list[str]
    explanation: str
    evidence: list[QuizEvidence]
    # Ids to light on the board once the question is answered, never before.
    highlight: list[str]


class ChoiceGrade(BaseModel):
    """How a picked set of options compares with the key."""

    result: Result
    missed: list[str]
    wrong: list[str]


class Mastery(BaseModel):
    """How much of the board the developer can defend right now."""

    total: int
    answered: int
    correct: int
    partial: int
    score: float
    weak_spots: list[str]


def build_quiz(system: SystemMap, analysis: ThreatAnalysis | None) -> list[QuizQuestion]:
    """The questions for a map and its threats, from structure first to threats and fixes last."""
    drafts = [
        _boundary_question(system),
        _data_question(system),
        _threat_question(system, analysis),
        _stride_question(system, analysis),
        _trifecta_question(system),
        _attack_question(system, analysis),
        _fix_question(system, analysis),
    ]
    return [question for question in drafts if question is not None]


def grade_choice(question: QuizQuestion, picked: Sequence[str]) -> ChoiceGrade:
    """Grade picked option ids against a choice question's key."""
    key = set(question.answer)
    chosen = list(dict.fromkeys(picked))
    missed = [item for item in question.answer if item not in chosen]
    wrong = [item for item in chosen if item not in key]
    if not missed and not wrong:
        return ChoiceGrade(result="correct", missed=[], wrong=[])
    if any(item in key for item in chosen):
        return ChoiceGrade(result="partial", missed=missed, wrong=wrong)
    return ChoiceGrade(result="wrong", missed=missed, wrong=wrong)


def mastery(questions: Sequence[QuizQuestion], latest: dict[str, Result]) -> Mastery:
    """Score the latest result for each current question, and list the elements behind misses."""
    current = [q for q in questions if q.id in latest]
    correct = sum(1 for q in current if latest[q.id] == "correct")
    partial = sum(1 for q in current if latest[q.id] == "partial")
    weak: list[str] = []
    for question in current:
        if latest[question.id] != "correct":
            weak.extend(i for i in question.highlight if i not in weak)
    score = (correct + 0.5 * partial) / len(questions) if questions else 0.0
    return Mastery(
        total=len(questions),
        answered=len(current),
        correct=correct,
        partial=partial,
        score=round(score, 3),
        weak_spots=weak,
    )


# =============================================================================
# Questions about structure
# =============================================================================


def _boundary_question(system: SystemMap) -> QuizQuestion | None:
    """Which of these flows cross a trust boundary."""
    crossing = [flow for flow in system.flows if crosses_boundary(system, flow)]
    internal = [flow for flow in system.flows if not crosses_boundary(system, flow)]
    if not crossing or not internal:
        return None
    # Three crossings from different senders keep the question from being "pick everything",
    # and internal flows into risky parts make the most tempting wrong answers.
    picked = _varied_by_source(_risky_first(system, crossing), 3)
    everything = _flow_options(system, system.flows)
    tempting = _flow_options(system, _risky_first(system, internal))
    options = _pick_options(everything, _flow_options(system, picked), tempting)
    answer = [o.id for o in options if o.id in {f.id for f in crossing}]
    ends = [end for flow in crossing if flow.id in answer for end in (flow.source, flow.target)]
    return QuizQuestion(
        id="boundary",
        topic="boundary",
        kind="multi",
        prompt="Which of these flows cross a trust boundary, where the receiving side has to check who sent the data?",
        options=options,
        answer=answer,
        expected=[],
        rubric=[],
        explanation=(
            "A flow crosses a trust boundary when its two ends run at different levels of trust. "
            f"Each crossing needs the spoofing check: {STRIDE['S'].question}"
        ),
        evidence=_evidence_for(system, answer),
        highlight=list(dict.fromkeys([*answer, *ends])),
    )


def _data_question(system: SystemMap) -> QuizQuestion | None:
    """Which components read from the first store that holds sensitive data."""
    for store in (n for n in system.nodes if n.sensitive):
        outgoing = [flow for flow in system.flows if flow.source == store.id]
        readers = list(dict.fromkeys(flow.target for flow in outgoing))
        if not readers:
            continue
        others = [QuizOption(id=n.id, label=n.label) for n in system.nodes if n.id != store.id]
        kinds = {n.id: n.kind for n in system.nodes}
        # Processes and other stores look like plausible readers; people and vendors rarely do.
        plausible = [o for o in others if kinds[o.id] == "process"] + [o for o in others if kinds[o.id] == "store"]
        options = _pick_options(others, [o for o in others if o.id in readers], [*plausible, *others])
        answer = [o.id for o in options if o.id in readers]
        used = [flow.id for flow in outgoing if flow.target in answer]
        return QuizQuestion(
            id=f"data:{store.id}",
            topic="data",
            kind="multi",
            prompt=f"{store.label} holds sensitive data. Which components receive data from it?",
            options=options,
            answer=answer,
            expected=[],
            rubric=[],
            explanation=(
                f"{store.label} sends data to {_join(label_of(system, None, i) for i in answer)}. "
                f"Each of them has to answer the disclosure question: {STRIDE['I'].question}"
            ),
            evidence=_evidence_for(system, used),
            highlight=[store.id, *used, *answer],
        )
    return None


def _trifecta_question(system: SystemMap) -> QuizQuestion | None:
    """Which flow breaks the lethal trifecta on the first AI component that has it, or which parts are its way out."""
    lethal = next((x for x in ai_exposure(system) if x.lethal), None)
    if lethal is None:
        return None
    node = node_index(system)[lethal.node]
    breakers = [flow for flow in system.flows if not _still_lethal(system, flow.id, node.id)]
    if not breakers:
        return _outbound_question(system, node, lethal.outbound)
    nearby = [flow for flow in system.flows if node.id in (flow.source, flow.target)]
    options = _pick_options(
        _flow_options(system, system.flows),
        _flow_options(system, breakers),
        _flow_options(system, [*nearby, *system.flows]),
    )
    answer = [o.id for o in options if o.id in {f.id for f in breakers}]
    single = len(answer) == 1
    reasons = [
        f"Without {flow_label(system, f)}, {node.label} loses {_lost_leg(system, f.id, node.id)}."
        for f in breakers
        if f.id in answer
    ]
    if single:
        ask = "Which one flow could you remove to break it?"
    else:
        ask = "Which flows, each removed on its own, would break it?"
    return QuizQuestion(
        id=f"trifecta:{node.id}",
        topic="trifecta",
        kind="single" if single else "multi",
        prompt=(
            f"{node.label} has the lethal trifecta: it reads sensitive data, takes in untrusted content, "
            f"and can send data out. {ask}"
        ),
        options=options,
        answer=answer,
        expected=[],
        rubric=[],
        explanation=" ".join(
            [*reasons, "Every other flow leaves all three legs standing, because each leg has another route."]
        ),
        evidence=_evidence_for(system, [*answer, node.id]),
        highlight=[node.id, *answer],
    )


def _outbound_question(system: SystemMap, node: Node, outbound: Sequence[str]) -> QuizQuestion:
    """Which parts give an AI component a way to send data out, for trifectas no single flow can break."""
    everyone = [QuizOption(id=n.id, label=n.label) for n in system.nodes if n.id != node.id]
    ways_out = [o for o in everyone if o.id in outbound]
    # The model provider is the most instructive wrong answer: it answers the component, it is not
    # a way out. Other external entities come next.
    nodes = node_index(system)
    providers = [o for o in everyone if nodes[o.id].kind == "external" and nodes[o.id].ai]
    externals = [o for o in everyone if nodes[o.id].kind == "external"]
    options = _pick_options(everyone, ways_out[:4], [*providers, *externals, *everyone])
    answer = [o.id for o in options if o.id in outbound]
    exits = [f.id for f in system.flows if f.source == node.id and f.target in answer]
    return QuizQuestion(
        id=f"trifecta:{node.id}",
        topic="trifecta",
        kind="multi",
        prompt=(
            f"{node.label} has the lethal trifecta: it reads sensitive data, takes in untrusted content, "
            "and can send data out. No single flow breaks it. Which of these give it a way to send data out?"
        ),
        options=options,
        answer=answer,
        expected=[],
        rubric=[],
        explanation=(
            f"{node.label} can reach {_join(label_of(system, None, i) for i in answer)}. "
            "Each is a channel an injected instruction could use, so each needs its own limit, "
            "such as an allowlist or a person approving the action."
        ),
        evidence=_evidence_for(system, [node.id, *exits]),
        highlight=[node.id, *exits, *answer],
    )


# =============================================================================
# Questions about threats
# =============================================================================


def _threat_question(system: SystemMap, analysis: ThreatAnalysis | None) -> QuizQuestion | None:
    """Where on the map the most severe threat happens."""
    ranked = _top_threats(analysis)
    if not ranked:
        return None
    threat = ranked[0]
    pinned = next((f for f in system.flows if f.id == threat.element), None)
    if pinned is not None:
        pool = _flow_options(system, system.flows)
    else:
        pool = [QuizOption(id=n.id, label=n.label) for n in system.nodes]
    target = next((o for o in pool if o.id == threat.element), None)
    if target is None:
        return None
    # Neighbors make the closest distractors and keep the answer from always sitting first.
    if pinned is not None:
        ends = {pinned.source, pinned.target}
        near = [f.id for f in system.flows if f.id != pinned.id and {f.source, f.target} & ends]
    else:
        touching = [f for f in system.flows if threat.element in (f.source, f.target)]
        near = [f.target if f.source == threat.element else f.source for f in touching]
    options = _pick_options(pool, [target], [*(o for o in pool if o.id in near), *pool], limit=4)
    category = STRIDE[threat.stride]
    return QuizQuestion(
        id=f"threat:{threat.id}",
        topic="threat",
        kind="single",
        # The title is on the pin, so the prompt describes the threat instead of naming it.
        prompt=f"The most severe threat is {threat.severity}: {threat.summary} Where on the map does it happen?",
        options=options,
        answer=[target.id],
        expected=[],
        rubric=[],
        explanation=f'It is {threat.id}, "{threat.title}", a case of {category.name.lower()}. {category.question}',
        evidence=[QuizEvidence(id=threat.id, label=f"{threat.id} {threat.title}", evidence=threat.evidence)],
        highlight=[target.id, threat.id],
    )


def _stride_question(system: SystemMap, analysis: ThreatAnalysis | None) -> QuizQuestion | None:
    """Which STRIDE category a threat belongs to, asked of the second worst threat to vary from `_threat_question`."""
    ranked = _top_threats(analysis)
    if not ranked:
        return None
    threat = ranked[1] if len(ranked) > 1 else ranked[0]
    category = STRIDE[threat.stride]
    return QuizQuestion(
        id=f"stride:{threat.id}",
        topic="stride",
        kind="single",
        prompt=f"What kind of threat is this? {threat.summary}",
        options=[QuizOption(id=letter, label=info.name) for letter, info in STRIDE.items()],
        answer=[threat.stride],
        expected=[],
        rubric=[],
        explanation=(
            f"{threat.id} is {category.name.lower()}: it breaks {category.property}. "
            f"The question to ask of {label_of(system, analysis, threat.element)}: {category.question}"
        ),
        evidence=[QuizEvidence(id=threat.id, label=f"{threat.id} {threat.title}", evidence=threat.evidence)],
        highlight=[threat.element, threat.id],
    )


def _attack_question(system: SystemMap, analysis: ThreatAnalysis | None) -> QuizQuestion | None:
    """In your own words: what happens when an untrusted source sends something malicious."""
    nodes = node_index(system)
    paths = sorted(analysis.paths if analysis else [], key=lambda p: severity_rank(p.severity))
    path = next((p for p in paths if p.steps and p.steps[0] in nodes and nodes[p.steps[0]].kind == "external"), None)
    if path is not None:
        source = nodes[path.steps[0]]
        hops = [
            flow.id
            for here, there in zip(path.steps, path.steps[1:], strict=False)
            for flow in system.flows
            if flow.source == here and flow.target == there
        ]
        titles = [label_of(system, analysis, t) for t in path.threats]
        return _open_attack(source, [*path.steps, *hops, *path.threats], [path.story, *titles], system)
    exposed = next((x for x in ai_exposure(system) if x.untrusted), None)
    if exposed is None:
        return None
    source = nodes[exposed.untrusted[0]]
    threats = [t.id for t in analysis.threats if t.element == exposed.node] if analysis else []
    rubric = [f"Content from {source.label} reaches {nodes[exposed.node].label}, an AI component"]
    return _open_attack(source, [source.id, exposed.node, *threats], rubric, system)


def _open_attack(source: Node, expected: list[str], rubric: list[str], system: SystemMap) -> QuizQuestion:
    """Build the open attack question about `source`."""
    return QuizQuestion(
        id=f"attack:{source.id}",
        topic="attack",
        kind="open",
        prompt=(
            f"Suppose something malicious comes from {source.label}. In your own words: "
            "what path does it take through the system, and what harm could it do?"
        ),
        options=[],
        answer=[],
        expected=list(dict.fromkeys(expected)),
        rubric=rubric,
        explanation="A complete answer follows the content hop by hop and ends with what the attacker gains.",
        evidence=_evidence_for(system, expected),
        highlight=list(dict.fromkeys(expected)),
    )


def _fix_question(system: SystemMap, analysis: ThreatAnalysis | None) -> QuizQuestion | None:
    """In your own words: how would you stop the most severe threat."""
    ranked = _top_threats(analysis)
    if not ranked:
        return None
    threat = ranked[0]
    return QuizQuestion(
        id=f"fix:{threat.id}",
        topic="fix",
        kind="open",
        prompt=f"{threat.id}, {threat.title}: {threat.summary} How would you stop it? Name one concrete change.",
        options=[],
        answer=[],
        expected=[threat.element, threat.id],
        rubric=threat.fixes,
        explanation=f"Fixes the threat model suggests: {_join(threat.fixes)}.",
        evidence=[QuizEvidence(id=threat.id, label=f"{threat.id} {threat.title}", evidence=threat.evidence)],
        highlight=[threat.element, threat.id],
    )


# =============================================================================
# Helpers
# =============================================================================


def _top_threats(analysis: ThreatAnalysis | None) -> list[Threat]:
    """Threats from most to least severe, ties broken by id number."""
    if analysis is None:
        return []
    return sorted(analysis.threats, key=lambda t: (severity_rank(t.severity), _id_number(t.id)))


def _id_number(item_id: str) -> int:
    """The number in an id such as `T12`, so `T10` sorts after `T9`."""
    digits = "".join(ch for ch in item_id if ch.isdigit())
    return int(digits) if digits else 0


def _still_lethal(system: SystemMap, flow_id: str, node_id: str) -> bool:
    """True when `node_id` keeps the lethal trifecta after `flow_id` is removed."""
    after = next((x for x in ai_exposure(remove_element(system, flow_id)) if x.node == node_id), None)
    return after is not None and after.lethal


def _lost_leg(system: SystemMap, flow_id: str, node_id: str) -> str:
    """Name the trifecta leg that removing `flow_id` takes away from `node_id`."""
    after = next((x for x in ai_exposure(remove_element(system, flow_id)) if x.node == node_id), None)
    if after is None or not after.private_data:
        return "its sensitive data"
    if not after.untrusted:
        return "its untrusted input"
    return "its way to send data out"


def _pick_options(
    everything: Sequence[QuizOption],
    answer: Sequence[QuizOption],
    preferred: Iterable[QuizOption],
    limit: int = MAX_OPTIONS,
) -> list[QuizOption]:
    """Every answer item plus distractors from `preferred`, shown in `everything` order so position tells nothing."""
    answer_ids = {o.id for o in answer}
    distractors = [o.id for o in _unique_by_id(preferred) if o.id not in answer_ids]
    # Keep room for one wrong option whenever one exists, so no question has every option right.
    shown = [o.id for o in answer][: limit - 1 if distractors else limit]
    chosen = set(shown)
    for option_id in distractors:
        if len(chosen) >= limit:
            break
        chosen.add(option_id)
    return [QuizOption(id=o.id, label=o.label) for o in everything if o.id in chosen]


def _flow_options(system: SystemMap, flows: Iterable[Flow]) -> list[QuizOption]:
    """Flows as options, each named by its two ends and its label."""
    return [QuizOption(id=f.id, label=flow_label(system, f)) for f in _unique_by_id(flows)]


def _evidence_for(system: SystemMap, ids: Iterable[str]) -> list[QuizEvidence]:
    """The evidence the map cites for each node or flow id, skipping ones that cite none."""
    nodes = node_index(system)
    flows = {flow.id: flow for flow in system.flows}
    evidence: list[QuizEvidence] = []
    for item in dict.fromkeys(ids):
        if item in nodes:
            evidence.append(QuizEvidence(id=item, label=nodes[item].label, evidence=nodes[item].evidence))
        elif item in flows and flows[item].evidence:
            flow = flows[item]
            evidence.append(QuizEvidence(id=item, label=flow_label(system, flow), evidence=flow.evidence or ""))
    return evidence


def _risky_first(system: SystemMap, flows: Sequence[Flow]) -> list[Flow]:
    """Flows touching an AI component or a sensitive store first, then the rest, each group in map order."""
    nodes = node_index(system)

    def risky(flow: Flow) -> bool:
        ends = [nodes[end] for end in (flow.source, flow.target) if end in nodes]
        return any(node.ai or node.sensitive for node in ends)

    return [f for f in flows if risky(f)] + [f for f in flows if not risky(f)]


def _varied_by_source(flows: Sequence[Flow], limit: int) -> list[Flow]:
    """Up to `limit` flows, taking one per sending node before a second from any node."""
    picked: list[Flow] = []
    senders: set[str] = set()
    for flow in flows:
        if len(picked) < limit and flow.source not in senders:
            picked.append(flow)
            senders.add(flow.source)
    for flow in flows:
        if len(picked) < limit and flow not in picked:
            picked.append(flow)
    return picked


def _unique_by_id[T: (QuizOption, Flow)](items: Iterable[T]) -> list[T]:
    """Keep the first item for each id, in order; models are unhashable, so dedupe by key."""
    seen: set[str] = set()
    kept: list[T] = []
    for item in items:
        if item.id not in seen:
            seen.add(item.id)
            kept.append(item)
    return kept


def _join(items: Iterable[str]) -> str:
    """Join words as `a, b and c`."""
    words = [item for item in items if item]
    if len(words) <= 1:
        return "".join(words)
    return f"{', '.join(words[:-1])} and {words[-1]}"
