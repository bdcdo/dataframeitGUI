"""Contrato estrutural do kill-switch de /api/llm/* (issue #186)."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

import routes.llm_routes as llm_routes
import routes.pydantic_routes as pydantic_routes
from config import Settings, settings
from main import create_app

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_settings_defaults_to_llm_enabled(monkeypatch) -> None:
    monkeypatch.delenv("LLM_ENABLED", raising=False)
    assert Settings(_env_file=None).llm_enabled is True


def test_settings_parses_explicit_false(monkeypatch) -> None:
    monkeypatch.setenv("LLM_ENABLED", "false")
    assert Settings(_env_file=None).llm_enabled is False


def test_fly_alpha_disables_frontend_and_backend() -> None:
    backend_fly = tomllib.loads((REPOSITORY_ROOT / "backend/fly.toml").read_text())
    frontend_fly = tomllib.loads((REPOSITORY_ROOT / "frontend/fly.toml").read_text())

    assert backend_fly["env"]["LLM_ENABLED"] == "false"
    assert frontend_fly["build"]["args"]["NEXT_PUBLIC_LLM_ENABLED"] == "false"


def test_disabled_switch_covers_every_llm_route(monkeypatch) -> None:
    monkeypatch.setattr(settings, "llm_enabled", False)
    app = create_app()
    client = TestClient(app, raise_server_exceptions=False)
    checked = 0

    for path, operations in app.openapi()["paths"].items():
        if not path.startswith("/api/llm/"):
            continue
        concrete_path = re.sub(r"\{[^}]+\}", "job-id", path)
        for method in operations:
            if method.upper() in {"HEAD", "OPTIONS", "PARAMETERS"}:
                continue
            response = client.request(
                method.upper(),
                concrete_path,
                json={"project_id": "p1", "field_names": ["field"]},
            )
            assert response.status_code == 403, (
                f"{method.upper()} {concrete_path} retornou {response.status_code}"
            )
            assert response.json() == {
                "detail": "Funcionalidades de LLM estão desabilitadas."
            }
            checked += 1

    assert checked >= 5


def test_disabled_switch_runs_before_paid_handler_work(
    monkeypatch, auth_headers
) -> None:
    monkeypatch.setattr(settings, "llm_enabled", False)

    def fail_init_job(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("init_job não deveria executar")

    monkeypatch.setattr(llm_routes, "init_job", fail_init_job)
    client = TestClient(create_app(), raise_server_exceptions=False)

    response = client.post(
        "/api/llm/run",
        json={"project_id": "p1"},
        headers=auth_headers,
    )

    assert response.status_code == 403


class _StoredPydanticCode:
    def select(self, *_args: object) -> "_StoredPydanticCode":
        return self

    def eq(self, *_args: object) -> "_StoredPydanticCode":
        return self

    def maybe_single(self) -> "_StoredPydanticCode":
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(
            data={
                "pydantic_code": (
                    "from pydantic import BaseModel\n\n"
                    "class Analysis(BaseModel):\n"
                    "    answer: str"
                )
            }
        )


class _PydanticSupabase:
    def table(self, _name: str) -> _StoredPydanticCode:
        return _StoredPydanticCode()


def test_disabled_switch_does_not_cover_pydantic_namespace(
    monkeypatch, auth_headers
) -> None:
    monkeypatch.setattr(settings, "llm_enabled", False)
    monkeypatch.setattr(
        pydantic_routes,
        "require_project_coordinator",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        pydantic_routes,
        "get_supabase",
        lambda: _PydanticSupabase(),
    )
    client = TestClient(create_app(), raise_server_exceptions=False)

    response = client.post(
        "/api/pydantic/recover-fields",
        json={"project_id": "p1"},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["valid"] is True
