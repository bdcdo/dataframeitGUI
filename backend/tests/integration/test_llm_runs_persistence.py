"""Contrato payload×schema do llm_runner em `llm_runs` contra o Supabase local (#674).

Os testes de `run_llm` usam um `_FakeTable` em memória que aceita qualquer
chave de payload, e por isso `_persist_run_snapshot` gravou `llm_runs.round_id`
por 11 dias sem que a coluna existisse (#673): o fake repetia o contrato em vez
de verificá-lo. Aqui cada write roda com um `supabase.Client` de verdade, e o
PostgREST recusa coluna inexistente (PGRST204) ou valor de tipo errado.

Três dos writes engolem a exceção e só logam (`_persist_run_progress`,
`_persist_run_completion`, `_persist_run_error`): a run principal não pode
morrer por causa deles. Por isso cada teste confere duas coisas: que nenhum
erro foi logado e que a linha relida do banco tem os valores escritos. A
releitura também pega o UPDATE que não casa com linha nenhuma.

Fora do `pytest -q` padrão (marcador `integration`, ver `addopts` em
`pyproject.toml`). Roda no gate de banco (`run-db-tests.sh` e
`database-tests.yml`) por `frontend/scripts/run-backend-integration.sh`, que
fornece as variáveis abaixo a partir do `supabase status`. À mão:

    cd frontend && npx supabase start && npm run test:db:llm-runs-contract
"""

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest
from supabase import Client, create_client

import services.llm_runner as llm_runner
from services.llm_runner import (
    _persist_run_completion,
    _persist_run_error,
    _persist_run_insert,
    _persist_run_progress,
    _persist_run_snapshot,
    get_job_status,
    mark_stale_runs_as_error,
)

pytestmark = pytest.mark.integration

URL_ENV = "INTEGRATION_SUPABASE_URL"
KEY_ENV = "INTEGRATION_SUPABASE_SERVICE_KEY"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

RUN_COLUMNS = (
    "status, phase, filter_mode, progress, total, heartbeat_at, completed_at, "
    "llm_provider, llm_model, document_count, pydantic_code, round_id, "
    "error_message, error_type, error_traceback, error_line, error_column, "
    "processed_complete, processed_partial, processed_empty"
)


@pytest.fixture(scope="module")
def sb() -> Client:
    url = os.environ.get(URL_ENV, "")
    key = os.environ.get(KEY_ENV, "")
    # Falha, e não skip: um gate que pula por falta de ambiente fica verde
    # sem ter testado nada.
    if not url or not key:
        pytest.fail(
            f"{URL_ENV} e {KEY_ENV} não definidas — rode por "
            "`npm run test:db:llm-runs-contract`, com o Supabase local no ar."
        )
    # Os testes escrevem e apagam linhas com a service key. Só contra o stack
    # local: uma URL de produção esquecida no ambiente não pode passar daqui.
    if urlparse(url).hostname not in LOOPBACK_HOSTS:
        pytest.fail(f"{URL_ENV} precisa apontar para o Supabase local, não {url}")
    return create_client(url, key)


@pytest.fixture
def project(sb: Client):
    """Projeto descartável; o trigger de INSERT cria a rodada corrente."""
    project_id = str(uuid.uuid4())
    sb.table("projects").insert(
        {"id": project_id, "name": f"contrato llm_runs {project_id}"}
    ).execute()
    try:
        row = (
            sb.table("projects")
            .select("id, current_round_id")
            .eq("id", project_id)
            .single()
            .execute()
            .data
        )
        assert row["current_round_id"], "trigger não criou a rodada inicial"
        yield row
    finally:
        # O cascade de projects leva rounds e llm_runs junto.
        sb.table("projects").delete().eq("id", project_id).execute()


def _read_run(sb: Client, job_id: str) -> dict:
    return (
        sb.table("llm_runs")
        .select(RUN_COLUMNS)
        .eq("job_id", job_id)
        .single()
        .execute()
        .data
    )


def _assert_run(sb: Client, job_id: str, **expected) -> dict:
    """Relê a run e compara as colunas pedidas de uma vez (o diff sai inteiro)."""
    row = _read_run(sb, job_id)
    assert {column: row[column] for column in expected} == expected
    return row


def _patch_run(sb: Client, job_id: str, **columns) -> None:
    """Prepara o estado da run por fora do runner."""
    sb.table("llm_runs").update(columns).eq("job_id", job_id).execute()


def _assert_nothing_swallowed(caplog: pytest.LogCaptureFixture) -> None:
    errors = [
        record.getMessage() + (f"\n{record.exc_text}" if record.exc_text else "")
        for record in caplog.records
        if record.name == "services.llm_runner" and record.levelno >= logging.ERROR
    ]
    assert not errors, "write engoliu erro do banco:\n" + "\n".join(errors)


def _new_run(sb: Client, project_id: str) -> str:
    # A rota gera job_id com uuid4 (routes/llm_routes.py) e a coluna é UUID.
    job_id = str(uuid.uuid4())
    _persist_run_insert(sb, job_id, project_id, "pending")
    return job_id


def test_insert_creates_running_row_in_current_round(sb, project):
    job_id = _new_run(sb, project["id"])

    row = _assert_run(
        sb,
        job_id,
        status="running",
        phase="loading",
        filter_mode="pending",
        # O INSERT não manda round_id; o trigger carimba a rodada corrente.
        round_id=project["current_round_id"],
    )
    assert row["heartbeat_at"] is not None


def test_snapshot_writes_config_and_captured_round(sb, project):
    job_id = _new_run(sb, project["id"])
    # Rodada diferente da que o trigger carimbou no INSERT: se o snapshot
    # deixasse de gravar round_id, a releitura ainda mostraria a corrente.
    other_round = (
        sb.table("rounds")
        .insert({"project_id": project["id"], "label": "segunda rodada"})
        .execute()
        .data[0]["id"]
    )
    code = "class Analysis(BaseModel):\n    x: str\n"

    _persist_run_snapshot(
        sb,
        job_id,
        {
            "llm_provider": "google_genai",
            "llm_model": "gemini-test",
            "pydantic_code": code,
            "current_round_id": other_round,
        },
        doc_count=7,
    )

    _assert_run(
        sb,
        job_id,
        llm_provider="google_genai",
        llm_model="gemini-test",
        document_count=7,
        pydantic_code=code,
        round_id=other_round,
    )


def test_progress_writes_counters_and_heartbeat(sb, project, caplog):
    job_id = _new_run(sb, project["id"])
    _patch_run(sb, job_id, heartbeat_at=None)
    counters = {
        "processed_complete": 3,
        "processed_partial": 2,
        "processed_empty": 1,
        "progress": 6,
    }

    _persist_run_progress(sb, job_id, counters)

    _assert_nothing_swallowed(caplog)
    row = _assert_run(sb, job_id, **counters)
    assert row["heartbeat_at"] is not None


def test_completion_writes_final_state_and_warnings(sb, project, caplog):
    job_id = _new_run(sb, project["id"])

    _persist_run_completion(
        sb,
        job_id,
        progress=5,
        total=5,
        warnings=["doc-1: campo x ausente"],
        counters={"processed_complete": 4, "processed_partial": 1},
    )

    _assert_nothing_swallowed(caplog)
    row = _assert_run(
        sb,
        job_id,
        status="completed",
        phase="completed",
        progress=5,
        total=5,
        processed_complete=4,
        processed_partial=1,
        processed_empty=0,
        error_message="Warnings (1 doc(s)): doc-1: campo x ausente",
    )
    assert row["completed_at"] is not None


def test_error_writes_diagnostics(sb, project, caplog):
    job_id = _new_run(sb, project["id"])
    exc = SyntaxError("invalid syntax", ("<pydantic_schema>", 4, 7, "x ="))
    tb = "Traceback (most recent call last): ..."

    line, col = _persist_run_error(
        sb, job_id, exc, tb, counters={"processed_complete": 1, "processed_empty": 2}
    )

    _assert_nothing_swallowed(caplog)
    assert (line, col) == (4, 7)
    row = _assert_run(
        sb,
        job_id,
        status="error",
        phase="error",
        error_message="invalid syntax (<pydantic_schema>, line 4)",
        error_type="SyntaxError",
        error_traceback=tb,
        error_line=4,
        error_column=7,
        processed_complete=1,
        processed_partial=0,
        processed_empty=2,
    )
    assert row["completed_at"] is not None


def test_mark_stale_runs_as_error_only_hits_runs_without_heartbeat(sb, project):
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    # Os dois ramos do `.or_()`: heartbeat velho, e run sem heartbeat (anterior
    # à coluna) com início velho. A sem heartbeat e início recente fica viva.
    stale_heartbeat = _new_run(sb, project["id"])
    _patch_run(sb, stale_heartbeat, heartbeat_at=old)
    stale_no_heartbeat = _new_run(sb, project["id"])
    _patch_run(sb, stale_no_heartbeat, heartbeat_at=None, started_at=old)
    fresh_no_heartbeat = _new_run(sb, project["id"])
    _patch_run(sb, fresh_no_heartbeat, heartbeat_at=None)
    alive = _new_run(sb, project["id"])

    assert mark_stale_runs_as_error(sb, project["id"]) == 2

    for job_id in (stale_heartbeat, stale_no_heartbeat):
        row = _assert_run(sb, job_id, status="error", phase="error")
        assert row["error_message"].startswith("Execução abandonada")
        assert row["completed_at"] is not None
    for job_id in (fresh_no_heartbeat, alive):
        _assert_run(sb, job_id, status="running")


def test_status_fallback_reads_persisted_run(sb, project, caplog, monkeypatch):
    # Não é write, mas lê as mesmas colunas por nome e também engole o erro:
    # coluna sumida viraria "Job not found" depois de um restart do backend.
    job_id = _new_run(sb, project["id"])
    _patch_run(sb, job_id, progress=3, processed_complete=2, processed_partial=1)
    monkeypatch.setattr(llm_runner, "get_supabase", lambda: sb)
    assert job_id not in llm_runner._jobs

    status = get_job_status(job_id)

    _assert_nothing_swallowed(caplog)
    expected = {
        "status": "running",
        "phase": "loading",
        "progress": 3,
        "processed_complete": 2,
        "processed_partial": 1,
        "processed_empty": 0,
    }
    assert {key: status[key] for key in expected} == expected
