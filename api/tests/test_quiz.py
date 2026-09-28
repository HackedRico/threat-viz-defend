from app.domain.quiz import QuizQuestion, Result, build_quiz, grade_choice, mastery
from tests.factories import analysis, flow, inbox, node, system, threat, trifecta_map


def questions_by_topic() -> dict[str, QuizQuestion]:
    example = inbox()
    return {q.topic: q for q in build_quiz(example.map, example.analysis)}


def test_inbox_quiz_asks_every_topic_in_teaching_order() -> None:
    example = inbox()
    topics = [q.topic for q in build_quiz(example.map, example.analysis)]
    assert topics == ["boundary", "data", "threat", "stride", "trifecta", "attack", "fix"]


def test_boundary_question_mixes_crossings_with_internal_flows() -> None:
    question = questions_by_topic()["boundary"]
    assert question.kind == "multi"
    assert 2 <= len(question.answer) < len(question.options)
    example = inbox().map
    from app.domain.rules import crosses_boundary

    flows = {f.id: f for f in example.flows}
    for option in question.options:
        assert crosses_boundary(example, flows[option.id]) == (option.id in question.answer)


def test_data_question_names_every_reader_of_the_sensitive_store() -> None:
    question = questions_by_topic()["data"]
    assert question.id == "data:db"
    assert set(question.answer) == {"sync", "agent", "api"}
    assert "db" in question.highlight


def test_threat_question_points_at_the_worst_threat() -> None:
    question = questions_by_topic()["threat"]
    assert question.answer == ["agent"]
    assert "agent" in {o.id for o in question.options}
    assert 2 <= len(question.options) <= 4
    # The prompt describes the threat without giving away its title.
    assert "takes over the triage agent" not in question.prompt


def test_stride_question_uses_the_second_threat() -> None:
    question = questions_by_topic()["stride"]
    assert question.id == "stride:T2"
    assert question.answer == ["I"]
    assert [o.id for o in question.options] == ["S", "T", "R", "I", "D", "E"]


def test_trifecta_without_a_single_breaker_asks_for_the_ways_out() -> None:
    question = questions_by_topic()["trifecta"]
    assert question.kind == "multi"
    assert set(question.answer) == {"google", "websites", "logs"}
    # The model provider is offered as the tempting wrong answer.
    assert "openai" in {o.id for o in question.options}


def test_many_ways_out_still_leave_a_wrong_option() -> None:
    outs = [node(f"out{n}", "external") for n in range(6)]
    many = system(
        [
            *outs,
            node("page", "external"),
            node("feed", "external"),
            node("agent", ai=True),
            node("vault", "store", sensitive=True),
            node("db", "store", sensitive=True),
        ],
        [
            flow("in1", "page", "agent"),
            flow("in2", "feed", "agent"),
            flow("s1", "vault", "agent"),
            flow("s2", "db", "agent"),
            *[flow(f"o{n}", "agent", f"out{n}") for n in range(6)],
        ],
    )
    question = next(q for q in build_quiz(many, None) if q.topic == "trifecta")
    shown = {o.id for o in question.options}
    assert set(question.answer) == {o for o in shown if o.startswith("out")}
    assert shown - set(question.answer)


def test_trifecta_with_a_single_breaker_asks_which_flow_breaks_it() -> None:
    small = trifecta_map()
    question = next(q for q in build_quiz(small, None) if q.topic == "trifecta")
    assert question.kind == "multi"
    assert set(question.answer) == {"f1", "f2", "f3"}
    assert "loses its sensitive data" in question.explanation


def test_attack_question_follows_the_worst_path_from_outside() -> None:
    question = questions_by_topic()["attack"]
    assert question.kind == "open"
    assert question.id == "attack:senders"
    assert {"senders", "agent", "f14", "T1"} <= set(question.expected)
    assert question.rubric


def test_fix_question_grades_against_the_threat_fixes() -> None:
    question = questions_by_topic()["fix"]
    assert question.id == "fix:T1"
    assert question.rubric == inbox().analysis.threats[0].fixes


def test_questions_about_threats_need_an_analysis() -> None:
    example = inbox()
    topics = {q.topic for q in build_quiz(example.map, None)}
    assert topics == {"boundary", "data", "trifecta", "attack"}


def test_grade_choice_tells_correct_partial_and_wrong_apart() -> None:
    question = questions_by_topic()["data"]
    right = list(question.answer)
    assert grade_choice(question, right).result == "correct"
    partial = grade_choice(question, [*right[:1], "web"])
    assert partial.result == "partial"
    assert partial.wrong == ["web"]
    assert grade_choice(question, ["web"]).result == "wrong"
    assert grade_choice(question, []).result == "wrong"


def test_mastery_scores_partials_as_half() -> None:
    quiz = build_quiz(trifecta_map(), analysis([threat("T1", "agent", "critical")]))
    latest: dict[str, Result] = {quiz[0].id: "correct", quiz[1].id: "partial"}
    score = mastery(quiz, latest)
    assert score.answered == 2
    assert score.score == round(1.5 / len(quiz), 3)
    assert set(quiz[1].highlight) <= set(score.weak_spots)


def test_picking_several_options_on_a_single_choice_question_is_wrong() -> None:
    # Partial credit made every single choice question free: pick all the options and half the score comes back.
    example = inbox()
    for question in (q for q in build_quiz(example.map, example.analysis) if q.kind == "single"):
        every = [option.id for option in question.options]
        assert grade_choice(question, every).result == "wrong"
        assert grade_choice(question, question.answer).result == "correct"
