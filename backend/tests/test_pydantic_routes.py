"""Testes do endpoint POST /api/pydantic/recover-fields."""

import pytest
from fastapi.testclient import TestClient

import routes.pydantic_routes as pr
from main import app
from services.auth import AuthUser, require_authenticated_user

PROJECT_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def client() -> TestClient:
    # Estes testes focam a LÓGICA do handler (404/200), não a auth (#195, coberta
    # em test_auth.py). Contorna o gate JWT via dependency_override; o no-op do
    # require_project_coordinator fica no _patch_supabase.
    app.dependency_overrides[require_authenticated_user] = lambda: AuthUser(id="u")
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        # pop só o override que ESTE fixture registrou: clear() apagaria também
        # overrides de outros fixtures no app global compartilhado.
        app.dependency_overrides.pop(require_authenticated_user, None)


class _FakeQuery:
    """Encadeia table/select/eq/maybe_single/execute como o supabase-py."""

    def __init__(self, response: object) -> None:
        self._response = response

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        return self._response


class _FakeSupabase:
    def __init__(self, response: object) -> None:
        self._response = response

    def table(self, *a, **k):
        return _FakeQuery(self._response)


class _Response:
    def __init__(self, data: object) -> None:
        self.data = data


def _patch_supabase(monkeypatch, response: object) -> None:
    monkeypatch.setattr(pr, "get_supabase", lambda: _FakeSupabase(response))
    # Auth coberta em test_auth.py; aqui o guard de coordenador é no-op para
    # isolar a lógica do handler.
    monkeypatch.setattr(
        pr, "require_project_coordinator", lambda project_id, user: None
    )


def test_recover_fields_404_quando_projeto_nao_existe(client, monkeypatch):
    # maybe_single retorna data=None para projeto inexistente — o guard deve
    # responder 404 claro, não 500 (a regressão que o single() causava).
    _patch_supabase(monkeypatch, _Response(None))
    r = client.post("/api/pydantic/recover-fields", json={"project_id": PROJECT_ID})
    assert r.status_code == 404
    assert r.json()["detail"] == "Projeto não encontrado"


def test_recover_fields_404_quando_sem_codigo(client, monkeypatch):
    _patch_supabase(monkeypatch, _Response({"pydantic_code": None}))
    r = client.post("/api/pydantic/recover-fields", json={"project_id": PROJECT_ID})
    assert r.status_code == 404
    assert "código Pydantic" in r.json()["detail"]


def test_recover_fields_reconstroi_campos_do_codigo_armazenado(client, monkeypatch):
    code = (
        "from pydantic import BaseModel, Field\n"
        "class Analysis(BaseModel):\n"
        '    x: str = Field(description="X")\n'
    )
    _patch_supabase(monkeypatch, _Response({"pydantic_code": code}))
    r = client.post("/api/pydantic/recover-fields", json={"project_id": PROJECT_ID})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    assert body["model_name"] == "Analysis"
    assert [f["name"] for f in body["fields"]] == ["x"]
