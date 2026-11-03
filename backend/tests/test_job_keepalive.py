"""Keepalive da Machine durante jobs de LLM e contagem de jobs ativos.

A API fica pausada no Fly quando não há tráfego; o que impede a pausa no meio
de um job é o stream que o processo abre para si mesmo enquanto houver job
ativo. Os casos que importam: job ativo conta, job terminado ou travado não
conta (senão a Machine nunca mais pausa), e ninguém de fora segura o stream.
"""

import asyncio
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from services import job_keepalive, llm_runner


@pytest.fixture(autouse=True)
def _isolated_jobs(monkeypatch):
    monkeypatch.setattr(llm_runner, "_jobs", {})


def _job(status: str, *, started_ago: float, persisted_ago: float | None) -> dict:
    now = time.time()
    return {
        "status": status,
        "started_at": now - started_ago,
        "last_progress_persist": 0.0 if persisted_ago is None else now - persisted_ago,
    }


def test_active_job_count_counts_only_running_jobs_with_recent_heartbeat() -> None:
    llm_runner._jobs.update(
        {
            "recem-iniciado": _job("running", started_ago=5, persisted_ago=None),
            "com-heartbeat": _job("running", started_ago=3 * 3600, persisted_ago=30),
            "terminado": _job("completed", started_ago=60, persisted_ago=10),
            "com-erro": _job("error", started_ago=60, persisted_ago=10),
            # Status preso em "running" sem heartbeat: thread travada ou except
            # que falhou ao gravar o erro. Não pode segurar a Machine.
            "travado": _job("running", started_ago=3600, persisted_ago=20 * 60),
        }
    )
    assert llm_runner.active_job_count() == 2


def test_health_reports_active_jobs() -> None:
    llm_runner._jobs["a"] = _job("running", started_ago=1, persisted_ago=None)
    response = TestClient(main.app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "active_jobs": 1}


def test_keepalive_route_hides_itself_without_the_process_token() -> None:
    client = TestClient(main.app)
    assert client.get(job_keepalive.KEEPALIVE_PATH).status_code == 404
    assert (
        client.get(
            job_keepalive.KEEPALIVE_PATH,
            headers={job_keepalive.TOKEN_HEADER: "chute"},
        ).status_code
        == 404
    )


def test_keepalive_route_streams_while_jobs_run_and_ends_without_them(
    monkeypatch,
) -> None:
    counts = iter([1, 1, 0])
    monkeypatch.setattr(job_keepalive, "active_job_count", lambda: next(counts))
    monkeypatch.setattr(job_keepalive, "_STREAM_TICK_SECONDS", 0.0)

    response = TestClient(main.app).get(
        job_keepalive.KEEPALIVE_PATH,
        headers={job_keepalive.TOKEN_HEADER: job_keepalive._TOKEN},
    )
    assert response.status_code == 200
    assert response.content == b"\n\n"


def test_loop_does_nothing_outside_fly(monkeypatch) -> None:
    monkeypatch.delenv("FLY_APP_NAME", raising=False)
    monkeypatch.delenv("FLY_MACHINE_ID", raising=False)
    asyncio.run(asyncio.wait_for(job_keepalive.run_job_keepalive_loop(), 1))


def test_loop_holds_a_stream_pinned_to_this_machine_while_jobs_run(
    monkeypatch,
) -> None:
    monkeypatch.setenv("FLY_APP_NAME", "app-teste")
    monkeypatch.setenv("FLY_MACHINE_ID", "machine-1")
    counts = iter([0, 1])
    monkeypatch.setattr(job_keepalive, "active_job_count", lambda: next(counts, 1))
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise asyncio.CancelledError

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(asyncio.CancelledError):
                await job_keepalive.run_job_keepalive_loop(
                    client, idle_check_seconds=0, retry_seconds=0
                )

    asyncio.run(scenario())
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://app-teste.fly.dev/internal/keepalive"
    assert request.headers["fly-force-instance-id"] == "machine-1"
    assert job_keepalive.is_keepalive_token(request.headers[job_keepalive.TOKEN_HEADER])


def test_loop_reopens_the_stream_after_a_failure(monkeypatch) -> None:
    monkeypatch.setenv("FLY_APP_NAME", "app-teste")
    monkeypatch.setenv("FLY_MACHINE_ID", "machine-1")
    monkeypatch.setattr(job_keepalive, "active_job_count", lambda: 1)
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(502)
        raise asyncio.CancelledError

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(asyncio.CancelledError):
                await job_keepalive.run_job_keepalive_loop(
                    client, idle_check_seconds=0, retry_seconds=0
                )

    asyncio.run(scenario())
    assert attempts == 2
