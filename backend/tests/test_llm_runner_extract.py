"""Tests for _extract_answers_from_row — NaN-safe extraction from result_df.

dataframeit deixa np.nan em rows que falharam no provider; bool(NaN) e True
em Python, entao um filtro ingenuo (`if val`) deixaria NaN passar como
"preenchido" e a resposta seria salva com lixo. Esta funcao precisa rejeitar
NaN explicitamente.
"""
import math

from pydantic import BaseModel
from services.llm_runner import _extract_answers_from_row


class _Sample(BaseModel):
    field_a: str | None = None
    field_b: list[str] | None = None
    field_c: int | None = None


def test_extract_basic_string_field():
    row = {"field_a": "valor", "field_b": None, "field_c": None}
    answers, justifications = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_a": "valor"}
    assert justifications == {}


def test_extract_skips_none_values():
    row = {"field_a": None, "field_b": None, "field_c": None}
    answers, _ = _extract_answers_from_row(row, _Sample)
    assert answers == {}


def test_extract_skips_nan_values():
    """NaN nunca deve entrar em answers (causa raiz do bug pre-PR #77)."""
    nan = float("nan")
    row = {"field_a": nan, "field_b": nan, "field_c": nan}
    answers, _ = _extract_answers_from_row(row, _Sample)
    assert answers == {}


def test_extract_keeps_list_as_list():
    row = {"field_a": None, "field_b": ["x", "y"], "field_c": None}
    answers, _ = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_b": ["x", "y"]}


def test_extract_stringifies_int():
    row = {"field_a": None, "field_b": None, "field_c": 42}
    answers, _ = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_c": "42"}


def test_extract_ignores_internal_dataframeit_columns():
    """Colunas como _dataframeit_status nao devem aparecer em answers."""
    row = {
        "field_a": "ok",
        "field_b": None,
        "field_c": None,
        "_dataframeit_status": "processed",
        "_error_details": None,
    }
    answers, _ = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_a": "ok"}
    assert "_dataframeit_status" not in answers
    assert "_error_details" not in answers


def test_extract_justifications_present():
    row = {
        "field_a": "ok",
        "field_b": None,
        "field_c": None,
        "field_a_justification": "porque sim",
    }
    answers, justifications = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_a": "ok"}
    assert justifications == {"field_a": "porque sim"}


def test_extract_skips_nan_justification():
    nan = float("nan")
    row = {
        "field_a": "ok",
        "field_b": None,
        "field_c": None,
        "field_a_justification": nan,
    }
    answers, justifications = _extract_answers_from_row(row, _Sample)
    assert answers == {"field_a": "ok"}
    assert justifications == {}


def test_extract_skips_empty_string_justification():
    row = {
        "field_a": "ok",
        "field_b": None,
        "field_c": None,
        "field_a_justification": "",
    }
    answers, justifications = _extract_answers_from_row(row, _Sample)
    assert justifications == {}


def test_nan_check_uses_math_isnan_semantics():
    """Sanity check: pd.isna(float('nan')) == True, mas isinstance(nan, int) e False."""
    assert math.isnan(float("nan"))
