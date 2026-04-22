"""Unit tests for conditional post-processing of LLM answers.

Reuses dataframeit.conditional.evaluate_condition — mirrors what
services.llm_runner.run_llm does after dataframeit returns.
"""
from dataframeit.conditional import evaluate_condition


def _postprocess(answers: dict, field_conditions: dict) -> dict:
    """Mirror of the in-place pruning in services.llm_runner.run_llm."""
    result = dict(answers)
    for field_name, condition in field_conditions.items():
        if not evaluate_condition(condition, result, field_name):
            result.pop(field_name, None)
    return result


def test_equals_condition_satisfied_keeps_value():
    answers = {"trigger": "sim", "follow": "parcial"}
    conds = {"follow": {"field": "trigger", "equals": "sim"}}
    assert _postprocess(answers, conds) == {"trigger": "sim", "follow": "parcial"}


def test_equals_condition_unsatisfied_drops_value():
    answers = {"trigger": "nao", "follow": "ignored"}
    conds = {"follow": {"field": "trigger", "equals": "sim"}}
    assert _postprocess(answers, conds) == {"trigger": "nao"}


def test_in_condition_allows_multiple_triggers():
    conds = {"follow": {"field": "trigger", "in": ["a", "b"]}}
    assert _postprocess({"trigger": "a", "follow": "x"}, conds) == {
        "trigger": "a",
        "follow": "x",
    }
    assert _postprocess({"trigger": "b", "follow": "x"}, conds) == {
        "trigger": "b",
        "follow": "x",
    }
    assert _postprocess({"trigger": "c", "follow": "x"}, conds) == {"trigger": "c"}


def test_exists_false_drops_when_trigger_present():
    conds = {"follow": {"field": "trigger", "exists": False}}
    assert _postprocess({"trigger": "value", "follow": "x"}, conds) == {
        "trigger": "value"
    }


def test_exists_true_keeps_when_trigger_present():
    conds = {"follow": {"field": "trigger", "exists": True}}
    assert _postprocess({"trigger": "value", "follow": "x"}, conds) == {
        "trigger": "value",
        "follow": "x",
    }


def test_unconditional_field_untouched():
    answers = {"a": "1", "b": "2"}
    assert _postprocess(answers, {}) == answers


def test_multiple_conditional_fields_independent():
    answers = {"trigger": "sim", "f1": "a", "f2": "b"}
    conds = {
        "f1": {"field": "trigger", "equals": "sim"},
        "f2": {"field": "trigger", "equals": "nao"},
    }
    assert _postprocess(answers, conds) == {"trigger": "sim", "f1": "a"}
