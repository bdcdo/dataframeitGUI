"""Unit tests for conditional post-processing of LLM answers.

Usa o evaluator local (``services.condition_evaluator``), que espelha a
semântica do frontend. Ver comentário no módulo sobre divergências com
``dataframeit.conditional``.
"""
from services.condition_evaluator import evaluate_condition


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


# --- Paridade com o frontend nas divergencias conhecidas ---


def test_not_equals_with_absent_trigger_hides():
    """Frontend esconde quando gatilho e None; backend deve concordar."""
    conds = {"follow": {"field": "trigger", "not_equals": "sim"}}
    assert _postprocess({"follow": "orphan"}, conds) == {}


def test_not_in_with_absent_trigger_hides():
    conds = {"follow": {"field": "trigger", "not_in": ["a", "b"]}}
    assert _postprocess({"follow": "orphan"}, conds) == {}


def test_exists_true_with_empty_string_hides():
    """Empty string nao deve contar como "existe"."""
    conds = {"follow": {"field": "trigger", "exists": True}}
    assert _postprocess({"trigger": "", "follow": "orphan"}, conds) == {
        "trigger": ""
    }


def test_exists_true_with_empty_list_hides():
    conds = {"follow": {"field": "trigger", "exists": True}}
    assert _postprocess({"trigger": [], "follow": "orphan"}, conds) == {
        "trigger": []
    }


def test_exists_false_with_empty_string_keeps():
    conds = {"follow": {"field": "trigger", "exists": False}}
    assert _postprocess({"trigger": "", "follow": "val"}, conds) == {
        "trigger": "",
        "follow": "val",
    }


def test_not_equals_with_present_trigger_normal_semantics():
    conds = {"follow": {"field": "trigger", "not_equals": "sim"}}
    assert _postprocess({"trigger": "nao", "follow": "x"}, conds) == {
        "trigger": "nao",
        "follow": "x",
    }
    assert _postprocess({"trigger": "sim", "follow": "x"}, conds) == {
        "trigger": "sim"
    }


def test_extract_field_conditions_from_compiled_model():
    """extract_field_conditions deve ler de json_schema_extra, nao do JSON."""
    from pydantic import BaseModel, Field
    from typing import Literal, Optional

    from services.condition_evaluator import extract_field_conditions

    class Analysis(BaseModel):
        trigger: Literal["sim", "nao"] = Field(description="trigger")
        follow: Optional[Literal["a", "b"]] = Field(
            default=None,
            description="follow",
            json_schema_extra={"condition": {"field": "trigger", "equals": "sim"}},
        )

    conds = extract_field_conditions(Analysis)
    assert conds == {"follow": {"field": "trigger", "equals": "sim"}}
