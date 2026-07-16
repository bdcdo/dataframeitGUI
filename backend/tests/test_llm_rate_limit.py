"""Rate-limit service and paid-route wiring."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import routes.llm_routes as routes
import services.llm_rate_limiter as limiter
from config import Settings, settings
from main import app
from services.auth import AuthUser, require_authenticated_user

USER_ID = "11111111-1111-1111-1111-111111111111"
PROJECT_ID = "22222222-2222-2222-2222-222222222222"
DOCUMENT_ID = "33333333-3333-3333-3333-333333333333"
JOB_ID = "44444444-4444-4444-4444-444444444444"


class _RpcQuery:
    def __init__(self, data: object = None, error: Exception | None = None) -> None:
        self.data = data
        self.error = error

    def execute(self):
        if self.error is not None:
            raise self.error
        return SimpleNamespace(data=self.data)


class _Supabase:
    def __init__(self, query: _RpcQuery) -> None:
        self.query = query
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name: str, params: dict) -> _RpcQuery:
        self.calls.append((name, params))
        return self.query


@pytest.mark.parametrize(
    "overrides",
    [
        {"llm_rate_limit_requests": 0},
        {"llm_rate_limit_requests": 10_001},
        {"llm_rate_limit_window_seconds": 0},
        {"llm_rate_limit_window_seconds": 86_401},
    ],
)
def test_rate_limit_settings_reject_unsafe_bounds(overrides: dict) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **overrides)


def test_rate_limit_settings_parse_environment_strings() -> None:
    configured = Settings(
        _env_file=None,
        llm_rate_limit_requests="7",
        llm_rate_limit_window_seconds="90",
    )
    assert configured.llm_rate_limit_requests == 7
    assert configured.llm_rate_limit_window_seconds == 90


def test_limiter_passes_typed_config_to_atomic_rpc(monkeypatch) -> None:
    supabase = _Supabase(_RpcQuery(data=[{"allowed": True, "retry_after_seconds": 17}]))
    monkeypatch.setattr(limiter, "get_supabase", lambda: supabase)
    monkeypatch.setattr(settings, "llm_rate_limit_requests", 7)
    monkeypatch.setattr(settings, "llm_rate_limit_window_seconds", 17)

    limiter.enforce_llm_rate_limit(PROJECT_ID, USER_ID)

    assert supabase.calls == [
        (
            "consume_llm_rate_limit",
            {
                "p_user_id": USER_ID,
                "p_project_id": PROJECT_ID,
                "p_limit": 7,
                "p_window_seconds": 17,
            },
        )
    ]


def test_limiter_returns_clear_429_and_retry_after(monkeypatch) -> None:
    supabase = _Supabase(
        _RpcQuery(data=[{"allowed": False, "retry_after_seconds": 23}])
    )
    monkeypatch.setattr(limiter, "get_supabase", lambda: supabase)

    with pytest.raises(HTTPException) as exc_info:
        limiter.enforce_llm_rate_limit(PROJECT_ID, USER_ID)

    assert exc_info.value.status_code == 429
    assert exc_info.value.headers == {"Retry-After": "23"}
    assert "23 segundos" in exc_info.value.detail


@pytest.mark.parametrize(
    "query",
    [
        _RpcQuery(error=RuntimeError("database unavailable")),
        _RpcQuery(data=[]),
        _RpcQuery(data=[{"allowed": 1, "retry_after_seconds": 10}]),
        _RpcQuery(data=[{"allowed": False, "retry_after_seconds": 0}]),
    ],
)
def test_limiter_fails_closed_on_infrastructure_or_contract_error(
    monkeypatch, query: _RpcQuery
) -> None:
    monkeypatch.setattr(limiter, "get_supabase", lambda: _Supabase(query))

    with pytest.raises(HTTPException) as exc_info:
        limiter.enforce_llm_rate_limit(PROJECT_ID, USER_ID)

    assert exc_info.value.status_code == 503
    assert "limite" in exc_info.value.detail


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[require_authenticated_user] = lambda: AuthUser(id=USER_ID)
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.pop(require_authenticated_user, None)


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/llm/run", {"project_id": PROJECT_ID}),
        (
            "/api/llm/run-field",
            {"project_id": PROJECT_ID, "field_names": ["q1"]},
        ),
    ],
)
def test_paid_routes_authorize_then_limit_then_initialize(
    client: TestClient, monkeypatch, path: str, payload: dict
) -> None:
    events: list[str] = []
    monkeypatch.setattr(
        routes,
        "require_project_coordinator",
        lambda project_id, user: events.append("authorize"),
    )
    monkeypatch.setattr(
        routes,
        "enforce_llm_rate_limit",
        lambda project_id, user_id: events.append("limit"),
    )
    monkeypatch.setattr(
        routes,
        "init_job",
        lambda job_id, project_id, mode: events.append("init"),
    )

    async def background(*args, **kwargs):
        events.append("background")

    monkeypatch.setattr(routes, "run_llm", background)
    monkeypatch.setattr(routes, "run_llm_fields", background)

    response = client.post(path, json=payload)

    assert response.status_code == 200
    assert events == ["authorize", "limit", "init", "background"]


def test_unauthorized_request_does_not_consume_budget(
    client: TestClient, monkeypatch
) -> None:
    consumed = False

    def deny(project_id, user):
        raise HTTPException(status_code=403, detail="denied")

    def consume(project_id, user_id):
        nonlocal consumed
        consumed = True

    monkeypatch.setattr(routes, "require_project_coordinator", deny)
    monkeypatch.setattr(routes, "enforce_llm_rate_limit", consume)

    response = client.post("/api/llm/run", json={"project_id": PROJECT_ID})

    assert response.status_code == 403
    assert consumed is False


def test_429_happens_before_job_initialization(client: TestClient, monkeypatch) -> None:
    initialized = False
    monkeypatch.setattr(
        routes, "require_project_coordinator", lambda project_id, user: None
    )

    def reject(project_id, user_id):
        raise HTTPException(
            status_code=429,
            detail="limit",
            headers={"Retry-After": "12"},
        )

    def initialize(job_id, project_id, mode):
        nonlocal initialized
        initialized = True

    monkeypatch.setattr(routes, "enforce_llm_rate_limit", reject)
    monkeypatch.setattr(routes, "init_job", initialize)

    response = client.post("/api/llm/run", json={"project_id": PROJECT_ID})

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "12"
    assert initialized is False


def test_non_paid_llm_routes_do_not_consume_budget(
    client: TestClient, monkeypatch
) -> None:
    consumed = 0

    def consume(project_id, user_id):
        nonlocal consumed
        consumed += 1

    monkeypatch.setattr(routes, "enforce_llm_rate_limit", consume)
    monkeypatch.setattr(
        routes, "require_project_coordinator", lambda project_id, user: None
    )
    monkeypatch.setattr(routes, "get_supabase", lambda: object())
    monkeypatch.setattr(
        routes, "mark_stale_runs_as_error", lambda supabase, project_id: 0
    )
    monkeypatch.setattr(routes, "require_job_access", lambda job_id, user: None)
    monkeypatch.setattr(
        routes,
        "get_job_status",
        lambda job_id: {
            "status": "running",
            "progress": 0,
            "total": 1,
            "errors": [],
        },
    )

    responses = [
        client.post("/api/llm/preview-prompt", json={}),
        client.post("/api/llm/cleanup-stale", json={"project_id": PROJECT_ID}),
        client.get(f"/api/llm/status/{JOB_ID}"),
    ]

    assert [response.status_code for response in responses] == [200, 200, 200]
    assert consumed == 0
