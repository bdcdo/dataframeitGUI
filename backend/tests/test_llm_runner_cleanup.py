"""Tests for mark_stale_runs_as_error — cleanup de runs orfas.

Cobertura: a query .or_() PostgREST usa sintaxe nao-trivial
(`heartbeat_at.lt.X,and(heartbeat_at.is.null,started_at.lt.Y)`); um typo
silencioso quebraria o cleanup sem qualquer sinal — runs morreriam em
'running' eternamente e o frontend religaria polling. Este teste fixa a
sintaxe e o pipeline de chamadas.
"""
from unittest.mock import MagicMock

from services.llm_runner import mark_stale_runs_as_error


def _build_sb_chain(returned_data):
    """Monta um mock que imita o builder do supabase-py (table -> update ->
    eq -> eq -> or_ -> execute) e captura os argumentos para asserts.
    """
    chain = MagicMock()
    chain.table.return_value = chain
    chain.update.return_value = chain
    chain.eq.return_value = chain
    chain.or_.return_value = chain
    chain.execute.return_value = MagicMock(data=returned_data)
    return chain


def test_cleanup_returns_count_of_marked_runs():
    sb = _build_sb_chain([{"job_id": "j1"}, {"job_id": "j2"}])
    n = mark_stale_runs_as_error(sb, "proj-123")
    assert n == 2


def test_cleanup_returns_zero_when_no_data():
    """data=None deve virar 0, nao explodir com TypeError."""
    sb = _build_sb_chain(None)
    assert mark_stale_runs_as_error(sb, "proj-123") == 0


def test_cleanup_filters_by_project_and_running_status():
    sb = _build_sb_chain([])
    mark_stale_runs_as_error(sb, "proj-abc")
    eq_calls = [tuple(c.args) for c in sb.eq.call_args_list]
    assert ("project_id", "proj-abc") in eq_calls
    assert ("status", "running") in eq_calls


def test_cleanup_or_clause_includes_heartbeat_and_null_branches():
    """Sintaxe da .or_() e o ponto frágil: validar que ambos os ramos estão
    presentes (heartbeat antigo OR (heartbeat null AND started_at antigo)).
    """
    sb = _build_sb_chain([])
    mark_stale_runs_as_error(sb, "proj-x")

    or_arg = sb.or_.call_args.args[0]
    assert "heartbeat_at.lt." in or_arg
    assert "and(heartbeat_at.is.null,started_at.lt." in or_arg


def test_cleanup_writes_error_status_and_message():
    sb = _build_sb_chain([])
    mark_stale_runs_as_error(sb, "proj-x")

    payload = sb.update.call_args.args[0]
    assert payload["status"] == "error"
    assert payload["phase"] == "error"
    assert "heartbeat" in payload["error_message"].lower()
    assert "completed_at" in payload
