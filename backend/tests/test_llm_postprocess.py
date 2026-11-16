"""Unit tests for conditional post-processing of LLM answers.

A poda é a do ``llm_runner`` (``_prune_inactive_conditionals``), sobre o
evaluator local (``services.condition_evaluator``), que espelha a semântica do
frontend. Ver comentário no módulo sobre divergências com
``dataframeit.conditional``.
"""

from services.condition_evaluator import evaluate_condition
from services.llm_runner import _prune_inactive_conditionals


def _prune(
    answers: dict, field_conditions: dict, justifications: dict | None = None
) -> tuple[dict, dict]:
    """A poda de verdade do llm_runner, sobre cópias."""
    answers = dict(answers)
    justifications = dict(justifications or {})
    _prune_inactive_conditionals(answers, justifications, field_conditions)
    return answers, justifications


def _postprocess(answers: dict, field_conditions: dict) -> dict:
    return _prune(answers, field_conditions)[0]


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
    assert _postprocess({"trigger": "", "follow": "orphan"}, conds) == {"trigger": ""}


def test_exists_true_with_empty_list_hides():
    conds = {"follow": {"field": "trigger", "exists": True}}
    assert _postprocess({"trigger": [], "follow": "orphan"}, conds) == {"trigger": []}


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
    assert _postprocess({"trigger": "sim", "follow": "x"}, conds) == {"trigger": "sim"}


def test_not_in_with_present_trigger_matching_hides():
    conds = {"follow": {"field": "trigger", "not_in": ["a", "b"]}}
    assert _postprocess({"trigger": "a", "follow": "x"}, conds) == {"trigger": "a"}


def test_not_in_with_present_trigger_not_matching_keeps():
    conds = {"follow": {"field": "trigger", "not_in": ["a", "b"]}}
    assert _postprocess({"trigger": "c", "follow": "x"}, conds) == {
        "trigger": "c",
        "follow": "x",
    }


def test_not_in_with_invalid_targets_hides():
    """`not_in` que nao e lista e tratado como condicao nao satisfeita."""
    conds = {"follow": {"field": "trigger", "not_in": "not-a-list"}}
    assert _postprocess({"trigger": "a", "follow": "x"}, conds) == {"trigger": "a"}


# --- Guards de entrada invalida ---


def test_condition_not_a_dict_is_treated_as_unsatisfied():
    assert evaluate_condition("bogus", {"trigger": "sim"}) is False


def test_condition_missing_field_key_is_treated_as_unsatisfied():
    assert evaluate_condition({"equals": "sim"}, {"trigger": "sim"}) is False


def test_condition_with_empty_field_is_treated_as_unsatisfied():
    assert (
        evaluate_condition({"field": "", "equals": "sim"}, {"trigger": "sim"}) is False
    )


def test_condition_none_is_always_visible():
    assert evaluate_condition(None, {}) is True


def test_extract_field_conditions_from_compiled_model():
    """extract_field_conditions deve ler de json_schema_extra, nao do JSON."""
    from typing import Literal, Optional

    from pydantic import BaseModel, Field

    from services.condition_evaluator import extract_field_conditions

    class Analysis(BaseModel):
        trigger: Literal["sim", "nao"] = Field(description="trigger")
        follow: Optional[Literal["a", "b"]] = Field(
            default=None,
            description="follow",
            json_schema_extra={"visible_if": {"field": "trigger", "equals": "sim"}},
        )
        legado: Optional[Literal["a", "b"]] = Field(
            default=None,
            description="legado",
            json_schema_extra={"condition": {"field": "trigger", "equals": "nao"}},
        )

    conds = extract_field_conditions(Analysis)
    assert conds == {
        "follow": {"field": "trigger", "equals": "sim"},
        "legado": {"field": "trigger", "equals": "nao"},
    }


# O frontend resolve a visibilidade até um ponto fixo (`dropHiddenConditionals`
# em `frontend/src/lib/conditional.ts`, #904). Os casos abaixo põem o
# dependente antes do gatilho na ordem do schema, que é onde a passada única
# divergia.
def test_dependente_antes_do_gatilho_oculto_tambem_sai():
    # b só aparece com a == "sim"; c só com b == "x". Com a == "não", b some, e
    # c, que dependia de b, some junto.
    conditions = {
        "c": {"field": "b", "equals": "x"},
        "b": {"field": "a", "equals": "sim"},
    }
    answers, justifications = _prune(
        {"a": "não", "b": "x", "c": "valor"},
        conditions,
        {"b": "porque", "c": "porque"},
    )

    assert answers == {"a": "não"}
    assert justifications == {}


def test_exists_false_fica_quando_o_gatilho_oculto_sai():
    # c aparece quando b não existe. b está oculto (a != "sim"), então para a
    # tela b não existe e c está visível: c fica, b sai.
    conditions = {
        "c": {"field": "b", "exists": False},
        "b": {"field": "a", "equals": "sim"},
    }
    answers, _ = _prune({"a": "não", "b": "x", "c": "valor"}, conditions)

    assert answers == {"a": "não", "c": "valor"}


def test_cadeia_visivel_fica_inteira():
    conditions = {
        "c": {"field": "b", "equals": "x"},
        "b": {"field": "a", "equals": "sim"},
    }
    answers, _ = _prune({"a": "sim", "b": "x", "c": "valor"}, conditions)

    assert answers == {"a": "sim", "b": "x", "c": "valor"}


def test_justificativa_de_condicional_oculta_sem_resposta_sai():
    answers, justifications = _prune(
        {"a": "não"},
        {"b": {"field": "a", "equals": "sim"}},
        {"a": "ok", "b": "sobrou"},
    )

    assert answers == {"a": "não"}
    assert justifications == {"a": "ok"}


def test_string_vazia_de_gatilho_oculto_tambem_e_zerada():
    # "" é valor para not_equals: mantido, deixaria c visível com b oculto.
    conditions = {
        "c": {"field": "b", "not_equals": "x"},
        "b": {"field": "a", "equals": "sim"},
    }
    answers, _ = _prune({"a": "não", "b": "", "c": "valor"}, conditions)

    assert answers == {"a": "não"}
