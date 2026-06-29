"""Testes do gate de autenticação/autorização (services/auth.py + rotas).

Cobre a verificação do JWT (HS256), as dependências FastAPI e as guards de
autorização, além da rejeição na borda das rotas (401 sem token, 403 para
não-coordenador) — sem tocar o backend de LLM real.
"""

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import routes.pydantic_routes as pydantic_routes_mod
import services.auth as auth_mod
from config import settings
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


@pytest.fixture(scope="module")
def rsa_private_key():
    # Gerar a chave uma vez por módulo (RSA-2048 é caro).
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def make_rs256_token(private_key, claims: dict | None = None) -> str:
    payload = {
        "supabase_uid": USER,
        "exp": int(time.time()) + 3600,
        **(claims or {}),
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


def configure_rs256(monkeypatch, public_key):
    # Liga o caminho RS256 e faz o PyJWKClient devolver a chave pública dada,
    # sem rede: substitui `_get_jwks_client`.
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    fake_client = SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=public_key)
    )
    monkeypatch.setattr(auth_mod, "_get_jwks_client", lambda: fake_client)


# ---- fake Supabase (honra os filtros .eq() para pegar bug de query) ----


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows
        self._filters: dict = {}
        self._single = False

    def select(self, *a, **k):
        return self

    def eq(self, column, value):
        # Aplicado de verdade no execute(): assim um filtro errado (ex.: esquecer
        # `.eq("role", "coordenador")`) reprova o teste em vez de passar batido.
        self._filters[column] = value
        return self

    def limit(self, *a, **k):
        return self

    def maybe_single(self):
        # Espelha o PostgREST: maybe_single retorna data=<dict> (a 1a linha) ou
        # None quando nenhuma casa — não uma lista. recover_fields depende disso.
        self._single = True
        return self

    def execute(self):
        rows = [
            r
            for r in self._rows
            if all(r.get(k) == v for k, v in self._filters.items())
        ]
        if self._single:
            return SimpleNamespace(data=rows[0] if rows else None)
        return SimpleNamespace(data=rows)


class FakeSupabase:
    def __init__(self, **tables):
        self._tables = tables

    def table(self, name):
        return _FakeTable(self._tables.get(name, []))


class _BoomTable:
    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        raise RuntimeError("db indisponível")


class _BoomSupabase:
    """Simula falha de infra: toda query levanta no execute()."""

    def table(self, name):
        return _BoomTable()


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


def test_verify_jwt_missing_exp_rejected():
    # require=["exp"]: token sem expiração nunca passa.
    token = jwt.encode({"supabase_uid": USER}, SECRET, algorithm="HS256")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


# ------------------------------ verify_jwt RS256 ------------------------------


def test_verify_jwt_rs256_valid(monkeypatch, rsa_private_key):
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    user = verify_jwt(make_rs256_token(rsa_private_key))
    assert user == AuthUser(id=USER)


def test_verify_jwt_rs256_wrong_signature_rejected(monkeypatch, rsa_private_key):
    # JWKS expõe a pública de `rsa_private_key`, mas o token é assinado por outra
    # chave → assinatura não bate → 401.
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(other_key))
    assert exc.value.status_code == 401


def test_verify_jwt_rs256_not_configured_is_503(rsa_private_key):
    # clerk_jwks_url vazio (default do _configure_secret) → 503 antes do JWKS.
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(rsa_private_key))
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
        FakeSupabase(master_users=[], projects=[{"id": "p1", "created_by": USER}]),
    )
    require_project_coordinator("p1", AuthUser(id=USER))


def test_coordinator_role(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": "p1", "created_by": "someone-else"}],
            project_members=[
                {"project_id": "p1", "user_id": USER, "role": "coordenador"}
            ],
        ),
    )
    require_project_coordinator("p1", AuthUser(id=USER))


def test_coordinator_denied_for_non_member(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": "p1", "created_by": "someone-else"}],
            project_members=[],
        ),
    )
    with pytest.raises(HTTPException) as exc:
        require_project_coordinator("p1", AuthUser(id=USER))
    assert exc.value.status_code == 403


def test_coordinator_denied_for_wrong_role(monkeypatch):
    # Membro do projeto, mas role != "coordenador". Só passa porque o fake honra
    # o `.eq("role", "coordenador")` — antes esse caso passaria batido.
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": "p1", "created_by": "someone-else"}],
            project_members=[
                {"project_id": "p1", "user_id": USER, "role": "pesquisador"}
            ],
        ),
    )
    with pytest.raises(HTTPException) as exc:
        require_project_coordinator("p1", AuthUser(id=USER))
    assert exc.value.status_code == 403


def test_coordinator_infra_error_is_503(monkeypatch):
    # Falha de banco ao verificar autorização vira 503 (fail-closed), não 500.
    use_supabase(monkeypatch, _BoomSupabase())
    with pytest.raises(HTTPException) as exc:
        require_project_coordinator("p1", AuthUser(id=USER))
    assert exc.value.status_code == 503


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
            llm_runs=[{"job_id": "job1", "project_id": "p1"}],
            master_users=[],
            projects=[{"id": "p1", "created_by": "other"}],
            project_members=[{"id": "m1", "project_id": "p1", "user_id": USER}],
        ),
    )
    assert require_job_access("job1", AuthUser(id=USER)) == "p1"


def test_job_access_non_member_403(monkeypatch):
    use_supabase(
        monkeypatch,
        FakeSupabase(
            llm_runs=[{"job_id": "job1", "project_id": "p1"}],
            master_users=[],
            projects=[{"id": "p1", "created_by": "other"}],
            project_members=[],
        ),
    )
    with pytest.raises(HTTPException) as exc:
        require_job_access("job1", AuthUser(id=USER))
    assert exc.value.status_code == 403


def test_job_access_infra_error_is_503(monkeypatch):
    # Falha de banco ao resolver o job vira 503 (fail-closed), não 500.
    use_supabase(monkeypatch, _BoomSupabase())
    with pytest.raises(HTTPException) as exc:
        require_job_access("job1", AuthUser(id=USER))
    assert exc.value.status_code == 503


# ------------------- borda das rotas (TestClient) -------------------


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/api/pydantic/recover-fields", {"project_id": "p1"}),
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
            master_users=[],
            projects=[{"id": "p1", "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/llm/run",
        json={"project_id": "p1"},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_recover_fields_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas o usuário não é coordenador do projeto → 403 antes de
    # qualquer leitura de pydantic_code (a guard é a primeira linha do handler).
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": "p1", "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/pydantic/recover-fields",
        json={"project_id": "p1"},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_recover_fields_allows_coordinator(client, monkeypatch):
    # Coordenador (aqui criador) passa o gate; o handler lê o pydantic_code
    # armazenado e o compila via AST allowlist.
    fake = FakeSupabase(
        master_users=[],
        projects=[
            {
                "id": "p1",
                "created_by": USER,
                "pydantic_code": "from pydantic import BaseModel\n\nclass Analysis(BaseModel):\n    x: str",
            }
        ],
        project_members=[],
    )
    use_supabase(monkeypatch, fake)
    # O handler chama get_supabase pela referência do PRÓPRIO módulo da rota; a
    # guard (require_project_coordinator) chama pela de services.auth. Patch nos
    # dois para o caminho feliz inteiro usar o fake.
    monkeypatch.setattr(pydantic_routes_mod, "get_supabase", lambda: fake)
    resp = client.post(
        "/api/pydantic/recover-fields",
        json={"project_id": "p1"},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is True
