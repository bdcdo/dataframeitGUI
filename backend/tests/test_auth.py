"""Testes do gate de autenticação/autorização (services/auth.py + rotas).

Cobre a verificação do JWT (HS256), as dependências FastAPI e as guards de
autorização, além da rejeição na borda das rotas (401 sem token, 403 para
não-coordenador) — sem tocar o backend de LLM real.
"""

import re
import time
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from conftest import TEST_JWT_SECRET
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import routes.llm_routes as llm_routes_mod
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

# Reusa o secret único do conftest em vez de redefinir um divergente: assim a
# verificação não depende de qual fixture autouse roda por último (conftest._auth_secret
# vs o _configure_secret deste módulo setam o MESMO valor).
SECRET = TEST_JWT_SECRET
USER = "11111111-1111-1111-1111-111111111111"
PROJECT = "22222222-2222-2222-2222-222222222222"
JOB = "33333333-3333-3333-3333-333333333333"

# Duas instâncias Clerk: a "de produção" (que o backend aceita) e a "de
# desenvolvimento" (que ele deve recusar). É esse par que exercita o cutover —
# ver test_verify_jwt_rs256_issuer_de_outra_instancia_rejeitado.
ISSUER = "https://clerk.test-prod.example/"
ISSUER_DEV = "https://test-dev.clerk.accounts.dev"


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


def configure_rs256(monkeypatch, public_key, issuer: str = ISSUER):
    # Liga o caminho RS256 e faz o PyJWKClient devolver a chave pública dada,
    # sem rede: substitui `_get_jwks_client`.
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", issuer)
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


@pytest.fixture(autouse=True)
def _reset_jwks_client():
    # `_jwks_client` é global de módulo (auth.py): sem zerar entre testes, um
    # cliente construído com a URL de um teste vaza para o seguinte e a falha
    # aparece longe da causa.
    auth_mod._jwks_client = None
    yield
    auth_mod._jwks_client = None


def use_supabase(monkeypatch, fake):
    monkeypatch.setattr(auth_mod, "get_supabase", lambda: fake)


# ---------------------------- verify_jwt ----------------------------


def test_verify_jwt_valid_extracts_supabase_uid():
    user = verify_jwt(make_token())
    assert user == AuthUser(id=USER)


def test_verify_jwt_sem_supabase_uid_e_503_e_nao_usa_sub():
    # Token bem assinado mas sem a claim que o RLS usa como identidade. Não há
    # fallback para `sub` (o ID do Clerk, que não casa nenhuma linha): isso viraria
    # 403/404 espalhados, escondendo a config quebrada atrás de "acesso negado".
    # 503 porque a credencial está boa — quem está mal configurado é o servidor.
    token = make_token({"supabase_uid": None, "sub": "user_2TestClerkId"})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 503


def test_verify_jwt_wrong_signature_rejected():
    bad = make_token(secret="another-secret-0123456789-abcdefghij-klmno")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(bad)
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


def test_verify_jwt_rs256_rejected_when_only_hs256_configured(rsa_private_key):
    # Só HS256 configurado (default do _configure_secret: secret setado, jwks
    # vazio) → RS256 fora da allowlist → 401 (não 503: o servidor ESTÁ
    # configurado, só não aceita esse algoritmo).
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(rsa_private_key))
    assert exc.value.status_code == 401


def test_verify_jwt_nothing_configured_rs256_is_503(monkeypatch, rsa_private_key):
    # Nem secret nem JWKS → allowlist vazia → 503 (fail-closed, mal configurado).
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")
    monkeypatch.setattr(settings, "clerk_jwks_url", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(rsa_private_key))
    assert exc.value.status_code == 503


def test_verify_jwt_hs256_rejected_when_jwks_configured(monkeypatch):
    # Downgrade fechado: com CLERK_JWKS_URL setado (produção RS256), um token
    # HS256 — mesmo assinado com o secret legado ainda presente — cai fora da
    # allowlist de algoritmos e é rejeitado (401), sem nem tentar decodificar.
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    # supabase_jwt_secret continua setado (coexistência), mas HS256 não é aceito.
    #
    # Este teste também fixa a ORDENAÇÃO dentro de `verify_jwt`: a fixture
    # autouse deixa o issuer vazio, então JWKS ligado sem issuer é justamente o
    # estado em que `_require_issuer` responderia 503. O 401 asserido aqui só se
    # mantém enquanto a allowlist de algoritmo for consultada ANTES do gate de
    # issuer — inverter as duas linhas em auth.py quebra esta asserção.
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token())
    assert exc.value.status_code == 401


def _raise_jwks_outage(token):
    raise jwt.PyJWKClientError("JWKS indisponível")


def test_verify_jwt_rs256_jwks_outage_is_503(monkeypatch, rsa_private_key):
    # Indisponibilidade do JWKS (rede/5xx do Clerk) é fail-closed: 503, não 401.
    # Sem isto, um blip no upstream viraria invalidação de token em massa.
    # O issuer é setado para que o 503 aqui prove a indisponibilidade — e não
    # seja o 503 de `_require_issuer` passando por baixo.
    monkeypatch.setattr(settings, "supabase_jwt_secret", "")
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", ISSUER)
    fake_client = SimpleNamespace(get_signing_key_from_jwt=_raise_jwks_outage)
    monkeypatch.setattr(auth_mod, "_get_jwks_client", lambda: fake_client)
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(rsa_private_key))
    assert exc.value.status_code == 503


# ------------------- forma de produção: session token RS256 -------------------
# Estes exercitam a configuração REAL do deploy (RS256 + JWKS + issuer), que
# nenhum outro teste tocava: os demais rodam HS256 sem issuer. Era essa lacuna
# que deixava a suíte verde enquanto produção rejeitaria todo token.


def test_verify_jwt_session_token_sem_aud_e_aceito(monkeypatch, rsa_private_key):
    # O session token do Clerk não emite `aud`. Um token com a forma real de
    # produção precisa passar — se este teste falhar com 401, a checagem de
    # audience voltou e o cutover quebra inteiro.
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    token = make_rs256_token(rsa_private_key)
    assert "aud" not in jwt.decode(token, options={"verify_signature": False})
    assert verify_jwt(token).id == USER


def test_verify_jwt_rs256_issuer_de_outra_instancia_rejeitado(
    monkeypatch, rsa_private_key
):
    # O cutover errado: token emitido pela instância de desenvolvimento chegando
    # num backend configurado para a de produção. É o trabalho que o `aud` fingia
    # fazer e que o `iss` faz de verdade — e a razão de o issuer ser obrigatório.
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    token = make_rs256_token(rsa_private_key, {"iss": ISSUER_DEV})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 401


def test_verify_jwt_rs256_sem_issuer_configurado_e_503(monkeypatch, rsa_private_key):
    # JWKS ligado sem issuer é config incompleta: 503 (culpa do servidor), não
    # 401 nem liberação. Espelha `_allowed_algorithms` vazio.
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_rs256_token(rsa_private_key))
    assert exc.value.status_code == 503


def test_verify_jwt_hs256_nao_exige_issuer():
    # Invariante inversa da anterior: a exigência de issuer é do caminho JWKS, e
    # o rollback HS256 continua aceitando token sem `iss` (nem `aud`, que saiu
    # deste PR). Não é esquecimento: ali a chave é o Supabase JWT secret, que não
    # é emitido pelo Clerk e não tem instância dev/prod para separar. Sem este
    # teste, transformar `_require_issuer` em "exige sempre" passaria verde e
    # derrubaria o rollback justamente quando ele fosse necessário.
    # As fixtures autouse já deixam HS256 ligado com jwks e issuer vazios.
    # Cobre só a AUSÊNCIA da exigência; que o `iss` continua sendo conferido
    # quando configurado — o estado real de um rollback, com o issuer ainda no
    # `[env]` — é o teste seguinte.
    token = make_token()
    assert "iss" not in jwt.decode(token, options={"verify_signature": False})
    assert verify_jwt(token).id == USER


def test_verify_jwt_hs256_valida_issuer_quando_configurado(monkeypatch):
    # A forma REAL do rollback, que o teste acima não exercita: sai o
    # CLERK_JWKS_URL, entra o SUPABASE_JWT_SECRET — e o CLERK_JWT_ISSUER
    # continua no `[env]` do fly.toml, porque ninguém edita o toml no meio de um
    # incidente. Nesse estado `_decode_kwargs` passa `issuer` ao PyJWT
    # independentemente do algoritmo, então o caminho HS256 *valida* `iss` mesmo
    # sem `_require_issuer` cobrar. Não é contradição com o teste acima: "não
    # exige a claim" e "confere a claim quando o issuer está configurado" são
    # invariantes distintas, e é esta que o deploy de rollback executaria.
    monkeypatch.setattr(settings, "clerk_jwt_issuer", ISSUER)
    assert verify_jwt(make_token({"iss": ISSUER})).id == USER
    with pytest.raises(HTTPException) as exc:
        verify_jwt(make_token({"iss": ISSUER_DEV}))
    assert exc.value.status_code == 401


def test_verify_jwt_session_token_sem_supabase_uid_e_503(monkeypatch, rsa_private_key):
    # O modo de falha silencioso do cutover: custom claim não replicado na
    # instância nova. Sem isto, `clerk_uid()` vira NULL e o RLS nega tudo sem
    # erro nenhum. Aqui, ao menos o backend fala alto.
    configure_rs256(monkeypatch, rsa_private_key.public_key())
    token = make_rs256_token(rsa_private_key, {"supabase_uid": None})
    with pytest.raises(HTTPException) as exc:
        verify_jwt(token)
    assert exc.value.status_code == 503


def test_lifespan_jwks_sem_issuer_derruba_o_boot(monkeypatch):
    # Config incompleta mata o processo em vez de virar 503 difuso em produção:
    # /health nunca fica verde e o Fly não transfere tráfego para a máquina nova.
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    with pytest.raises(RuntimeError, match="CLERK_JWT_ISSUER"):
        with TestClient(main.app):
            pass  # pragma: no cover — o boot levanta antes


def test_lifespan_jwks_com_issuer_sobe(monkeypatch):
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", ISSUER)
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
