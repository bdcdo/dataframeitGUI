"""Tests for _build_llm_error_message — diagnostic stored in responses.llm_error.

A hierarquia importa: erro do dataframeit pode coexistir com is_empty=True
(quando a row inteira falhou e veio so com NaN), e o message deve preferir
o erro cru porque e mais informativo.
"""
from services.llm_runner import _build_llm_error_message


def _kwargs(**overrides):
    base = dict(
        dfi_error=None,
        is_empty=False,
        is_partial=False,
        dfi_status="processed",
        pre_prune_keys=[],
        post_prune_keys=[],
        answered_count=0,
        active_expected_count=0,
    )
    base.update(overrides)
    return base


def test_dataframeit_error_takes_precedence():
    msg = _build_llm_error_message(**_kwargs(
        dfi_error="rate limit exceeded",
        is_empty=True,
        is_partial=True,
        dfi_status="error",
    ))
    assert msg is not None
    assert msg.startswith("dataframeit:")
    assert "rate limit exceeded" in msg


def test_empty_after_prune_when_no_dfi_error():
    msg = _build_llm_error_message(**_kwargs(
        is_empty=True,
        pre_prune_keys=["q1", "q2", "q3"],
    ))
    assert msg is not None
    assert msg.startswith("answers vazio após prune")
    assert "['q1', 'q2', 'q3']" in msg


def test_partial_coverage_message():
    msg = _build_llm_error_message(**_kwargs(
        is_partial=True,
        pre_prune_keys=["q1", "q2"],
        post_prune_keys=["q1"],
        answered_count=1,
        active_expected_count=5,
    ))
    assert msg is not None
    assert msg.startswith("cobertura baixa (1/5)")
    assert "post_prune_keys=['q1']" in msg


def test_healthy_response_returns_none():
    """Resposta saudavel: nem erro, nem vazia, nem parcial. Mensagem fica null."""
    assert _build_llm_error_message(**_kwargs()) is None


def test_dfi_status_appears_in_empty_message():
    msg = _build_llm_error_message(**_kwargs(
        is_empty=True,
        dfi_status="error",
        pre_prune_keys=[],
    ))
    assert msg is not None
    assert "dfi_status=error" in msg
