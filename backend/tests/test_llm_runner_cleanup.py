"""Tests for mark_stale_runs_as_error — cleanup de runs orfas.

Cobertura: a query .or_() PostgREST usa sintaxe nao-trivial
(`heartbeat_at.lt.X,and(heartbeat_at.is.null,started_at.lt.Y)`); um typo
silencioso quebraria o cleanup sem qualquer sinal — runs morreriam em
'running' eternamente e o frontend religaria polling. Este teste fixa a
sintaxe e o pipeline de chamadas.
"""
import re
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


def test_cleanup_or_clause_matches_full_postgrest_syntax():
    """Sintaxe da .or_() e o ponto frágil: validar formato completo.

    Substring checks isolados deixariam passar reordenamentos quebrados
    como `and(started_at.lt.X,heartbeat_at.is.null)` (PostgREST AND é
    comutativo, mas o teste espelha a ordem do código atual). O regex
    abaixo casa o formato exato esperado pela query do mark_stale_runs_as_error.
    """
    sb = _build_sb_chain([])
    mark_stale_runs_as_error(sb, "proj-x")

    or_arg = sb.or_.call_args.args[0]
    # ISO 8601 timestamps de datetime.isoformat() com tzinfo: dígitos, "-",
    # "T", ":", ".", "+". Sem vírgulas ou parênteses (essenciais para que a
    # sintaxe da .or_() funcione — ver comentário em mark_stale_runs_as_error).
    iso_re = r"\d{4}-\d{2}-\d{2}T[\d:.+\-]+"
    pattern = (
        rf"^heartbeat_at\.lt\.{iso_re},"
        rf"and\(heartbeat_at\.is\.null,started_at\.lt\.{iso_re}\)$"
    )
    assert re.match(pattern, or_arg), (
        f"or_clause não bate com formato esperado.\n"
        f"esperado regex: {pattern}\n"
        f"recebido:       {or_arg}"
    )


def test_cleanup_heartbeat_cutoff_is_10_minutes():
    """Cutoff sincronizado com getRunningLlmJob no frontend (10min). Se este
    teste falhar após mudar o cutoff, atualize tambem
    frontend/src/actions/llm.ts:getRunningLlmJob.
    """
    from datetime import datetime, timezone, timedelta

    sb = _build_sb_chain([])
    before = datetime.now(timezone.utc)
    mark_stale_runs_as_error(sb, "proj-x")
    after = datetime.now(timezone.utc)

    or_arg = sb.or_.call_args.args[0]
    heartbeat_iso = or_arg.split(",", 1)[0].removeprefix("heartbeat_at.lt.")
    heartbeat_dt = datetime.fromisoformat(heartbeat_iso)

    expected_min = before - timedelta(minutes=10, seconds=1)
    expected_max = after - timedelta(minutes=10) + timedelta(seconds=1)
    assert expected_min <= heartbeat_dt <= expected_max, (
        f"heartbeat cutoff fora da janela 10min: {heartbeat_dt}"
    )


def test_cleanup_writes_error_status_and_message():
    sb = _build_sb_chain([])
    mark_stale_runs_as_error(sb, "proj-x")

    payload = sb.update.call_args.args[0]
    assert payload["status"] == "error"
    assert payload["phase"] == "error"
    assert "heartbeat" in payload["error_message"].lower()
    assert "completed_at" in payload
