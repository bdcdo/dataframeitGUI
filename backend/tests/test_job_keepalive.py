"""Keepalive da Machine durante jobs de LLM e contagem de jobs ativos.

Com autostop ligado, o Fly pausaria a API sem tráfego; o que impede a pausa no
meio de um job é o stream que o processo abre para si mesmo enquanto houver job
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
    before = int(time.time())
    response = TestClient(main.app).get("/health")
    after = int(time.time())
    assert response.status_code == 200
    body = response.json()
    assert before <= body.pop("server_time") <= after
    assert body == {"status": "ok", "active_jobs": 1}


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


def test_keepalive_token_with_non_ascii_header_is_rejected_not_an_error() -> None:
    # `hmac.compare_digest` com str fora do ASCII levanta TypeError; a rota
    # pública transformaria isso em 500 e sinalizaria que existe.
    assert job_keepalive.is_keepalive_token("chute-ç") is False
    response = TestClient(main.app).get(
        job_keepalive.KEEPALIVE_PATH,
        headers={job_keepalive.TOKEN_HEADER: "chute-ç".encode("latin-1")},
    )
    assert response.status_code == 404


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


def test_lifespan_starts_the_keepalive_loop(monkeypatch) -> None:
    # Fio entre o módulo e a aplicação: sem esta tarefa no lifespan, nada abre
    # o stream, e com autostop ligado o proxy pausaria a Machine no meio de
    # um job longo. O dublê
    # registra a chamada ao ser invocado, e não dentro da corrotina, para que o
    # teste não dependa de a tarefa chegar a rodar antes do fim do lifespan.
    # Sem FRONTEND_INTERNAL_URL o loop de reconciliação não sobe, então o
    # keepalive é a única tarefa de fundo aqui.
    monkeypatch.setattr(main.settings, "frontend_internal_url", "")
    calls: list[None] = []

    async def idle() -> None:
        await asyncio.Event().wait()

    def fake_loop():
        calls.append(None)
        return idle()

    monkeypatch.setattr(main, "run_job_keepalive_loop", fake_loop)

    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
    assert calls == [None]


def test_loop_opens_no_stream_while_no_job_runs(monkeypatch) -> None:
    # Sem job, nenhuma requisição pode sair: com autostop ligado, o stream
    # seguraria a Machine acordada para sempre e a pausa por ociosidade nunca
    # aconteceria.
    monkeypatch.setenv("FLY_APP_NAME", "app-teste")
    monkeypatch.setenv("FLY_MACHINE_ID", "machine-1")
    idle_iterations = 3
    count_calls = 0

    def fake_count() -> int:
        nonlocal count_calls
        count_calls += 1
        if count_calls > idle_iterations:
            raise asyncio.CancelledError
        return 0

    monkeypatch.setattr(job_keepalive, "active_job_count", fake_count)
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
    assert requests == []
    assert count_calls == idle_iterations + 1
