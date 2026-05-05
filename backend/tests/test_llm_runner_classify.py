"""Tests for _answers_have_content — classifies a response as empty or not.

Espelha LlmResponseRow.classifyResponse no frontend; divergencia aqui leva a
counters live (LlmConfigurePane) inconsistentes com badges (LlmResponseRow).
"""
from services.llm_runner import _answers_have_content


def test_empty_dict_has_no_content():
    assert _answers_have_content({}) is False


def test_only_none_values_has_no_content():
    assert _answers_have_content({"a": None, "b": None}) is False


def test_empty_string_is_no_content():
    assert _answers_have_content({"a": ""}) is False


def test_whitespace_string_is_no_content():
    assert _answers_have_content({"a": "   \n\t"}) is False


def test_non_empty_string_has_content():
    assert _answers_have_content({"a": "valor"}) is True


def test_empty_list_is_no_content():
    assert _answers_have_content({"a": []}) is False


def test_non_empty_list_has_content():
    assert _answers_have_content({"a": ["x"]}) is True


def test_empty_dict_value_is_no_content():
    assert _answers_have_content({"a": {}}) is False


def test_non_empty_dict_value_has_content():
    assert _answers_have_content({"a": {"k": "v"}}) is True


def test_zero_int_has_content():
    # int 0 e bool False sao valores legitimos para o LLM (ex: "quantidade",
    # "presenca booleana"). Tratar como vazio mascararia respostas validas.
    assert _answers_have_content({"a": 0}) is True


def test_false_bool_has_content():
    assert _answers_have_content({"a": False}) is True


def test_mix_of_empty_and_useful_has_content():
    assert _answers_have_content({"a": "", "b": None, "c": "ok"}) is True


def test_mix_of_all_empty_kinds_has_no_content():
    assert _answers_have_content({"a": "", "b": None, "c": [], "d": {}}) is False
