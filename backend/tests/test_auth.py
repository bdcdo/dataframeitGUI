"""Testes do gate de autenticação/autorização (services/auth.py + rotas).

Cobre a verificação do JWT (RS256 + JWKS), as dependências FastAPI e as guards de
autorização, além da rejeição na borda das rotas (401 sem token, 403 para
não-coordenador) — sem tocar o backend de LLM real.
"""

import re
import time
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from conftest import TEST_ISSUER, TEST_RSA_PRIVATE_KEY
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import routes.llm_routes as llm_routes_mod
import routes.pydantic_routes as pydantic_routes_mod
import services.auth as auth_mod
from config import Settings, settings
from services.auth import (
    AuthUser,
    require_authenticated_user,
    require_job_access,
    require_project_coordinator,
    verify_jwt,
)

# Segredo simétrico só para forjar os tokens HS* que o backend precisa recusar.
# >= 48 bytes para o HS384 não disparar o aviso de comprimento de chave do pyjwt.
SECRET = "hs" * 32
USER = "11111111-1111-1111-1111-111111111111"
PROJECT = "22222222-2222-2222-2222-222222222222"
JOB = "33333333-3333-3333-3333-333333333333"

# Duas instâncias Clerk: a "de produção" (que o backend aceita) e a "de
# desenvolvimento" (que ele deve recusar). É esse par que exercita o cutover —
# ver test_verify_jwt_issuer_de_outra_instancia_rejeitado.
ISSUER = TEST_ISSUER
ISSUER_DEV = "https://test-dev.clerk.accounts.dev"


def make_token(claims: dict | None = None, private_key=TEST_RSA_PRIVATE_KEY) -> str:
    """Token RS256 com a forma real de um session token do Clerk.

    Espelha os claims default do session token (azp, iat, jti, nbf, sid, sub, v)
    mais os custom claims que a instância injeta (`supabase_uid` para o
    `clerk_uid()` do RLS, `role` para o PostgREST). Note a **ausência de `aud`**:
    o session token não emite essa claim, ao contrário do JWT template legado.
    """
    now = int(time.time())
    payload = {
        "azp": "https://app.test",
        "exp": now + 3600,
        "iat": now,
        "iss": ISSUER,
        "jti": "abc123",
        "nbf": now - 1,
        "sid": "sess_test",
        "sub": "user_2TestClerkId",
        "v": 2,
        "role": "authenticated",
        "supabase_uid": USER,
        **(claims or {}),
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


def make_hs256_token() -> str:
    return jwt.encode(
        {"supabase_uid": USER, "iss": ISSUER, "exp": int(time.time()) + 3600},
        SECRET,
        algorithm="HS256",
    )


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


def use_supabase(monkeypatch, fake):
    monkeypatch.setattr(auth_mod, "get_supabase", lambda: fake)


# ---------------------------- verify_jwt ----------------------------
# A fixture autouse do conftest deixa a configuração REAL do deploy ligada
# (RS256 + JWKS + issuer), e `make_token` emite um token com a forma do session
# token do Clerk. Suíte em configuração que produção não tem fica verde
# enquanto produção quebra (#487, #488).


def test_verify_jwt_valid_extracts_supabase_uid():
    user = verify_jwt(make_token())
    assert user == AuthUser(id=USER)


def test_verify_jwt_session_token_sem_aud_e_aceito():
    # O session token do Clerk não emite `aud`. Um token com a forma real de
    # produção precisa passar — se este teste falhar com 401, a checagem de
    # audience voltou e o cutover quebra inteiro.
    token = make_token()
    assert "aud" not in jwt.decode(token, options={"verify_signature": False})
    assert verify_jwt(token).id == USER


def test_verify_jwt_sem_supabase_uid_e_503_e_nao_usa_sub():
    # Token bem assinado mas sem a claim que o RLS usa como identidade. Não há
    # fallback para `sub` (o ID do Clerk, que não casa nenhuma linha): isso viraria
    # 403/404 espalhados, escondendo a config quebrada atrás de "acesso negado".
    # 503 porque a credencial está boa — quem está mal configurado é o servidor.
    # É o modo de falha silencioso do cutover: custom claim não replicado na
    # instância nova. Sem isto, `clerk_uid()` vira NULL e o RLS nega tudo sem
    # erro nenhum. Aqui, ao menos o backend fala alto.
    token = make_token({"supabase_uid": None, "sub": "user_2TestClerkId"})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 503


def test_verify_jwt_wrong_signature_rejected():
    # O JWKS expõe a pública da chave de teste, mas o token é assinado por outra
    # chave → assinatura não bate → 401.
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token(private_key=other_key))
    assert exc.value.status_code == 401


def test_verify_jwt_expired_rejected():
    # Expira bem além do leeway (jwt_leeway_seconds=30) para não ser absorvido.
    token = make_token({"exp": int(time.time()) - 3600})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_within_leeway_accepted(monkeypatch):
    # Token recém-expirado dentro do leeway é aceito: absorve skew de relógio /
    # expiração de borda do token de ~60s, evitando derrubar run em curso.
    monkeypatch.setattr(settings, "jwt_leeway_seconds", 30)
    token = make_token({"exp": int(time.time()) - 5})
    assert verify_jwt(token).id == USER


def test_verify_jwt_missing_exp_rejected():
    # require=["exp"]: token sem expiração nunca passa.
    token = jwt.encode(
        {"supabase_uid": USER, "iss": ISSUER}, TEST_RSA_PRIVATE_KEY, algorithm="RS256"
    )
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_unsupported_alg_rejected():
    token = jwt.encode({"supabase_uid": USER}, SECRET, algorithm="HS384")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_alg_none_rejected():
    # "alg: none" — token sem assinatura nunca deve passar.
    token = jwt.encode({"supabase_uid": USER}, key=None, algorithm="none")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_hs256_rejected(monkeypatch):
    # Downgrade fechado: um token HS256 é recusado (401) sem nem tentar
    # decodificar, qualquer que seja o segredo que o assinou.
    #
    # Este teste também fixa a ORDENAÇÃO dentro de `verify_jwt`: JWKS ligado sem
    # issuer é justamente o estado em que `_require_issuer` responderia 503. O
    # 401 asserido aqui só se mantém enquanto o algoritmo for conferido ANTES do
    # gate de issuer — inverter as duas linhas em auth.py quebra esta asserção.
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_hs256_token())
    assert exc.value.status_code == 401


def test_verify_jwt_not_configured_is_503(monkeypatch):
    # Sem JWKS não há como verificar nada: 503 (fail-closed, mal configurado),
    # e não 401, mesmo para um token que seria válido.
    monkeypatch.setattr(settings, "clerk_jwks_url", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())
    assert exc.value.status_code == 503


def test_env_com_variavel_removida_falha_nomeando_a_variavel(tmp_path):
    # A linha vinha descomentada no .env.example antigo, então sobra no .env de
    # quem já tinha o backend rodando. O boot continua falhando (a variável não
    # tem mais efeito, e fingir que tem seria pior), mas dizendo o que apagar.
    env = tmp_path / ".env"
    env.write_text("SUPABASE_JWT_SECRET=qualquer\n")
    with pytest.raises(ValueError, match="SUPABASE_JWT_SECRET foi removida"):
        Settings(_env_file=env)


def test_hs256_recusado_mesmo_com_o_secret_legado_no_ambiente(monkeypatch):
    # Regressão do #488: o estado que o caminho de rollback aceitava. Um
    # SUPABASE_JWT_SECRET esquecido no ambiente, sem JWKS, fazia o backend
    # validar token HS256 assinado com ele. Sem o ramo, a variável não é lida e
    # o servidor responde 503 (sem JWKS não há como verificar nada).
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    fresh = Settings(_env_file=None, clerk_jwks_url="", clerk_jwt_issuer="")
    monkeypatch.setattr(auth_mod, "settings", fresh)
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_hs256_token())
    assert exc.value.status_code == 503


def _raise_jwks_outage(token):
    raise jwt.PyJWKClientError("JWKS indisponível")


def test_verify_jwt_jwks_outage_is_503(monkeypatch):
    # Indisponibilidade do JWKS (rede/5xx do Clerk) é fail-closed: 503, não 401.
    # Sem isto, um blip no upstream viraria invalidação de token em massa.
    # O issuer segue setado (fixture autouse), então o 503 aqui prova a
    # indisponibilidade — e não é o 503 de `_require_issuer` passando por baixo.
    fake_client = SimpleNamespace(get_signing_key_from_jwt=_raise_jwks_outage)
    monkeypatch.setattr(auth_mod, "_get_jwks_client", lambda: fake_client)
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())
    assert exc.value.status_code == 503


def _real_jwks_client(monkeypatch, kid: str) -> None:
    """PyJWKClient de verdade, com o download do JWKS trocado por um de uma chave."""
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(
        TEST_RSA_PRIVATE_KEY.public_key(), as_dict=True
    )
    client = jwt.PyJWKClient(settings.clerk_jwks_url)
    monkeypatch.setattr(
        client, "fetch_data", lambda: {"keys": [{**jwk, "kid": kid, "use": "sig"}]}
    )
    monkeypatch.setattr(auth_mod, "_get_jwks_client", lambda: client)


def test_verify_jwt_resolve_a_chave_pelo_kid(monkeypatch):
    # O fake do conftest devolve a chave para qualquer token; aqui a busca pelo
    # `kid` é a do PyJWKClient: o `kid` do JWKS passa, e um desconhecido é 503
    # (indistinguível, do lado de cá, de um JWKS desatualizado ou fora do ar).
    _real_jwks_client(monkeypatch, kid="k1")
    known = jwt.encode(
        jwt.decode(make_token(), options={"verify_signature": False}),
        TEST_RSA_PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": "k1"},
    )
    assert verify_jwt(known).id == USER
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())  # sem `kid`
    assert exc.value.status_code == 503


def test_verify_jwt_payload_malformado_e_401(monkeypatch):
    # Header válido, payload que não é JSON: o PyJWKClient levanta DecodeError
    # (e não PyJWKClientError) ao abrir o token para procurar o `kid`. É
    # credencial inválida, 401 — não pode escapar como 500 nem virar o 503 do
    # JWKS.
    _real_jwks_client(monkeypatch, kid="k1")
    header, _, signature = make_token().split(".")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(f"{header}.bm90IGpzb24.{signature}")
    assert exc.value.status_code == 401


def test_verify_jwt_issuer_de_outra_instancia_rejeitado():
    # O cutover errado: token emitido pela instância de desenvolvimento chegando
    # num backend configurado para a de produção. É o trabalho que o `aud` fingia
    # fazer e que o `iss` faz de verdade — e a razão de o issuer ser obrigatório.
    token = make_token({"iss": ISSUER_DEV})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_sem_issuer_configurado_e_503(monkeypatch):
    # JWKS ligado sem issuer é config incompleta: 503 (culpa do servidor), não
    # 401 nem liberação. Espelha o JWKS ausente.
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())
    assert exc.value.status_code == 503


def test_lifespan_jwks_sem_issuer_derruba_o_boot(monkeypatch):
    # Config incompleta mata o processo em vez de virar 503 difuso em produção:
    # /health nunca fica verde e o Fly não transfere tráfego para a máquina nova.
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    with pytest.raises(RuntimeError, match="CLERK_JWT_ISSUER"):
        with TestClient(main.app):
            pass  # pragma: no cover — o boot levanta antes


def test_lifespan_sem_jwks_sobe_avisando(monkeypatch, caplog):
    # Sem JWKS o boot não cai (o /health segue 200), mas toda rota autenticada
    # responde 503: o log é o que aponta a causa.
    monkeypatch.setattr(settings, "clerk_jwks_url", "")
    with caplog.at_level("ERROR", logger="main"), TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
    assert "CLERK_JWKS_URL não configurado" in caplog.text


def test_lifespan_jwks_com_issuer_sobe():
    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200


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
    require_job_access("job1", AuthUser(id=USER))  # não levanta (retorna None)


def test_job_access_non_member_is_404(monkeypatch):
    # Job existe, mas o usuário não pertence ao projeto → 404 (mesmo código de
    # "job inexistente") para não vazar a existência do job (oráculo de
    # enumeração fechado).
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
    assert exc.value.status_code == 404


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


# Rotas /api/* públicas (sem auth). Vazio hoje — TODA rota dos routers exige
# JWT. Se uma rota pública for adicionada, listá-la aqui explicitamente.
_PUBLIC_API_PATHS: set[str] = set()


def test_every_api_route_rejects_without_token(client):
    """Sem token, TODA rota sob /api/* responde 401.

    Dinâmico (lê o schema OpenAPI de `main.app`) em vez de lista hardcoded: uma
    rota nova que toque dados e esqueça o gate é pega aqui automaticamente, em
    vez de passar batido por não estar numa lista manual.
    """
    schema = main.app.openapi()
    checked = 0
    for path, ops in schema["paths"].items():
        if not path.startswith("/api/") or path in _PUBLIC_API_PATHS:
            continue
        # Substitui path params ({job_id}) por um placeholder concreto.
        concrete = re.sub(r"\{[^}]+\}", "x", path)
        for method in ops:
            if method.upper() in {"HEAD", "OPTIONS", "PARAMETERS"}:
                continue
            resp = client.request(method.upper(), concrete, json={})
            assert resp.status_code == 401, f"{method} {concrete} = {resp.status_code}"
            checked += 1
    assert checked >= 6, f"esperava cobrir >=6 endpoints, cobriu {checked}"


def test_run_field_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas não-coordenador → 403 antes de init_job/run_llm_fields.
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": PROJECT, "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/llm/run-field",
        json={"project_id": PROJECT, "field_names": ["a"]},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_cleanup_stale_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas não-coordenador → 403 antes de mark_stale_runs_as_error.
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": PROJECT, "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/llm/cleanup-stale",
        json={"project_id": PROJECT},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_status_not_found_for_non_member(client, monkeypatch):
    # Job existe, mas o usuário não é membro do projeto → 404 (oráculo fechado),
    # antes de get_job_status. Garante o wiring do guard na rota de status.
    use_supabase(
        monkeypatch,
        FakeSupabase(
            llm_runs=[{"job_id": JOB, "project_id": PROJECT}],
            master_users=[],
            projects=[{"id": PROJECT, "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.get(
        f"/api/llm/status/{JOB}",
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 404


def test_run_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas o usuário não é coordenador do projeto → 403, antes de
    # qualquer init_job/run_llm (a guard é a primeira linha do handler).
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": PROJECT, "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/llm/run",
        json={"project_id": PROJECT},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403


def test_run_forbidden_for_master_impersonating(client, monkeypatch):
    # Interlock de somente-leitura (issue #428): master é coordenador em todo
    # projeto, então passa o gate de coordenador; mas com impersonating=true a
    # execução é barrada (403) antes de init_job/run_llm — espelha o
    # requireWritableUser do frontend.
    use_supabase(monkeypatch, FakeSupabase(master_users=[{"user_id": USER}]))
    init_job = Mock()
    run_llm = Mock()
    monkeypatch.setattr(llm_routes_mod, "init_job", init_job)
    monkeypatch.setattr(llm_routes_mod, "run_llm", run_llm)
    resp = client.post(
        "/api/llm/run",
        json={"project_id": PROJECT, "impersonating": True},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 403
    # A barreira morde antes de qualquer trabalho: nenhum job fantasma é criado.
    init_job.assert_not_called()
    run_llm.assert_not_called()


def test_run_allows_master_when_not_impersonating(client, monkeypatch):
    # Sem o sinal de impersonação, o master roda normalmente: o interlock só
    # morde quando impersonating=true (default false não bloqueia).
    fake = FakeSupabase(master_users=[{"user_id": USER}])
    use_supabase(monkeypatch, fake)
    monkeypatch.setattr(llm_routes_mod, "enforce_llm_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(llm_routes_mod, "init_job", lambda *a, **k: None)
    monkeypatch.setattr(llm_routes_mod, "run_llm", lambda *a, **k: None)
    resp = client.post(
        "/api/llm/run",
        json={"project_id": PROJECT},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert "job_id" in resp.json()


def test_run_allows_non_master_coordinator_even_with_flag(client, monkeypatch):
    # Não-master ignora o sinal (mesma predicação do frontend): um coordenador
    # legítimo que por acaso enviasse impersonating=true não é bloqueado.
    fake = FakeSupabase(
        master_users=[],
        projects=[{"id": PROJECT, "created_by": USER}],
        project_members=[],
    )
    use_supabase(monkeypatch, fake)
    monkeypatch.setattr(llm_routes_mod, "enforce_llm_rate_limit", lambda *a, **k: None)
    monkeypatch.setattr(llm_routes_mod, "init_job", lambda *a, **k: None)
    monkeypatch.setattr(llm_routes_mod, "run_llm", lambda *a, **k: None)
    resp = client.post(
        "/api/llm/run",
        json={"project_id": PROJECT, "impersonating": True},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200


def test_recover_fields_forbidden_for_non_coordinator(client, monkeypatch):
    # Token válido, mas o usuário não é coordenador do projeto → 403 antes de
    # qualquer leitura de pydantic_code (a guard é a primeira linha do handler).
    use_supabase(
        monkeypatch,
        FakeSupabase(
            master_users=[],
            projects=[{"id": PROJECT, "created_by": "other"}],
            project_members=[],
        ),
    )
    resp = client.post(
        "/api/pydantic/recover-fields",
        json={"project_id": PROJECT},
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
                "id": PROJECT,
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
        json={"project_id": PROJECT},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is True


def test_cleanup_stale_allows_coordinator(client, monkeypatch):
    # Coordenador (aqui criador) passa o gate; o handler chama
    # mark_stale_runs_as_error e devolve a contagem. Complementa o teste
    # negativo (403) garantindo que o caminho autorizado responde 200.
    fake = FakeSupabase(
        master_users=[],
        projects=[{"id": PROJECT, "created_by": USER}],
        project_members=[],
    )
    use_supabase(monkeypatch, fake)
    # O handler chama get_supabase pela referência do PRÓPRIO módulo da rota; a
    # guard (require_project_coordinator) chama pela de services.auth.
    monkeypatch.setattr(llm_routes_mod, "get_supabase", lambda: fake)
    monkeypatch.setattr(
        llm_routes_mod, "mark_stale_runs_as_error", lambda sb, project_id: 3
    )
    resp = client.post(
        "/api/llm/cleanup-stale",
        json={"project_id": PROJECT},
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["cleaned"] == 3


def test_status_allows_member(client, monkeypatch):
    # Membro do projeto dono do job (aqui criador) passa o gate; o handler chama
    # get_job_status e devolve 200. Complementa o teste negativo (404) garantindo
    # que o caminho autorizado responde com o status da run.
    fake = FakeSupabase(
        llm_runs=[{"job_id": JOB, "project_id": PROJECT}],
        master_users=[],
        projects=[{"id": PROJECT, "created_by": USER}],
        project_members=[],
    )
    use_supabase(monkeypatch, fake)
    monkeypatch.setattr(
        llm_routes_mod,
        "get_job_status",
        lambda job_id: {
            "status": "running",
            "progress": 1,
            "total": 4,
            "errors": [],
        },
    )
    resp = client.get(
        f"/api/llm/status/{JOB}",
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "running"


def test_status_fallback_com_fase_nula_devolve_200(client, monkeypatch):
    # Backend reiniciado: o job saiu da memória e a rota lê `llm_runs`, onde
    # `phase` é anulável. `StatusResponse.phase` é `str`, e a linha com fase
    # nula fazia a validação da resposta falhar, ou seja, 500.
    fake = FakeSupabase(
        llm_runs=[
            {
                "job_id": JOB,
                "project_id": PROJECT,
                "status": "running",
                "phase": None,
                "progress": 2,
                "total": 4,
            }
        ],
        master_users=[],
        projects=[{"id": PROJECT, "created_by": USER}],
        project_members=[],
    )
    use_supabase(monkeypatch, fake)
    monkeypatch.setattr("services.llm_runner.get_supabase", lambda: fake)
    resp = client.get(
        f"/api/llm/status/{JOB}",
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert resp.status_code == 200
    assert resp.json()["phase"] == "loading"
    assert resp.json()["progress"] == 2
