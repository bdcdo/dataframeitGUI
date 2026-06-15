"""Testes do gate de autenticação/autorização (services/auth.py + rotas).

Cobre a verificação do JWT (HS256), as dependências FastAPI e as guards de
autorização, além da rejeição na borda das rotas (401 sem token, 403 para
não-coordenador) — sem tocar o backend de LLM real.
"""
import time
from types import SimpleNamespace

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from config import settings
import services.auth as auth_mod
from services.auth import (
    AuthUser,
    require_authenticated_user,
    require_job_access,
    require_project_coordinator,
    verify_jwt,
)

SECRET = "test-secret-please-change-0123456789-abcdef"
USER = "11111111-1111-1111-1111-111111111111"


def make_token(claims: dict | None = None, secret: str = SECRET) -> str:
    payload = {
        "supabase_uid": USER,
        "exp": int(time.time()) + 3600,
        **(claims or {}),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


# ---- fake Supabase (ignora filtros; retorna o data fixo por tabela) ----


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        return SimpleNamespace(data=list(self._rows))


class FakeSupabase:
    def __init__(self, **tables):
        self._tables = tables

    def table(self, name):
        return _FakeTable(self._tables.get(name, []))


@pytest.fixture(autouse=True)
def _configure_secret(monkeypatch):
    # HS256 ligado por padrão; testes que querem "não configurado" sobrescrevem.
    monkeypatch.setattr(settings, "supabase_jwt_secret", SECRET)
    monkeypatch.setattr(settings, "clerk_jwks_url", "")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    monkeypatch.setattr(settings, "clerk_jwt_audience", "")


def use_supabase(monkeypatch, fake):
    monkeypatch.setattr(auth_mod, "get_supabase", lambda: fake)


# ---------------------------- verify_jwt ----------------------------


def test_verify_jwt_valid_extracts_supabase_uid():
    user = verify_jwt(make_token())
    assert user == AuthUser(id=USER)


def test_verify_jwt_falls_back_to_sub():
    token = make_token({"supabase_uid": None, "sub": "clerk-abc"})
    assert verify_jwt(token).id == "clerk-abc"


def test_verify_jwt_wrong_signature_rejected():
    bad = make_token(secret="another-secret-0123456789-abcdefghij-klmno")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(bad)
    assert exc.value.status_code == 401


def test_verify_jwt_expired_rejected():
    token = make_token({"exp": int(time.time()) - 10})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_unsupported_alg_rejected():
    # HS384 exige chave >= 48 bytes; usa uma longa só para não emitir aviso.
    token = jwt.encode({"supabase_uid": USER}, SECRET * 2, algorithm="HS384")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_alg_none_rejected():
    # "alg: none" — token sem assinatura nunca deve passar.
    token = jwt.encode({"supabase_uid": USER}, key=None, algorithm="none")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_not_configured_is_503(monkeypatch):
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())
    assert exc.value.status_code == 503


# ---------------------- require_authenticated_user ----------------------


def test_require_auth_missing_header():
    with pytest.raises(HTTPException) as exc:
        require_authenticated_user(authorization=None)
    assert exc.value.status_code == 401


def test_require_auth_non_bearer_scheme():
    with pytest.raises(HTTPException) as exc:
        require_authenticated_user(authorization="Basic abc")
    assert exc.value.status_code == 401


def test_require_auth_valid_bearer():
    user = require_authenticated_user(authorization=f"Bearer {make_token()}")
    assert user.id == USER


# ---------------------- require_project_coordinator ----------------------


def test_coordinator_master(monkeypatch):
    use_supabase(monkeypatch, FakeSupabase(master_users=[{"user_id": USER}]))
    require_project_coordinator("p1", AuthUser(id=USER))  # não levanta


def test_coordinator_creator(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(master_users=[], projects=[{"created_by": USER}]),
    )
    require_project_coordinator("p1", AuthUser(id=USER))


def test_coordinator_role(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"created_by": "someone-else"}],
            project_members=[{"role": "coordenador"}],
        ),
    )
    require_project_coordinator("p1", AuthUser(id=USER))


def test_coordinator_denied_for_non_member(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"created_by": "someone-else"}],
            project_members=[],
        ),
    )
    with pytest.raises(HTTPException) as exc:
        require_project_coordinator("p1", AuthUser(id=USER))
    assert exc.value.status_code == 403


# ---------------------------- require_job_access ----------------------------


def test_job_access_missing_job_is_404(monkeypatch):
    use_supabase(monkeypatch, FakeSupabase(llm_runs=[]))
    with pytest.raises(HTTPException) as exc:
        require_job_access("job1", AuthUser(id=USER))
    assert exc.value.status_code == 404


def test_job_access_member_ok(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            llm_runs=[{"project_id": "p1"}],
            master_users=[],
            projects=[{"created_by": "other"}],
            project_members=[{"id": "m1"}],
        ),
    )
    assert require_job_access("job1", AuthUser(id=USER)) == "p1"


def test_job_access_non_member_403(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            llm_runs=[{"project_id": "p1"}],
            master_users=[],
            projects=[{"created_by": "other"}],
            project_members=[],
        ),
    )
    with pytest.raises(HTTPException) as exc:
        require_job_access("job1", AuthUser(id=USER))
    assert exc.value.status_code == 403


# ------------------- borda das rotas (TestClient) -------------------


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/api/pydantic/validate", {"code": "x = 1"}),
        ("post", "/api/llm/run", {"project_id": "p1"}),
        ("post", "/api/llm/run-field", {"project_id": "p1", "field_names": ["a"]}),
        ("post", "/api/llm/cleanup-stale", {"project_id": "p1"}),
        ("post", "/api/llm/preview-prompt", {"prompt_template": "x"}),
        ("get", "/api/llm/status/job1", None),
    ],
)
def test_routes_reject_without_token(client, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 401


def test_run_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas o usuário não é coordenador do projeto → 403, antes de
    # qualquer init_job/run_llm (a guard é a primeira linha do handler).
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[], projects=[{"created_by": "other"}], project_members=[]
        ),
    )
    resp = client.post(
        "/api/llm/run",
        json={"project_id": "p1"},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_validate_allows_authenticated_user(client):
    # /validate exige apenas autenticação (não há project_id). Com token válido
    # passa o gate e compila o schema.
    resp = client.post(
        "/api/pydantic/validate",
        json={"code": "from pydantic import BaseModel\n\nclass Analysis(BaseModel):\n    x: str"},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is True
