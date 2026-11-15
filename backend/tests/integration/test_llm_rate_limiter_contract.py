"""Contrato do limitador de execuções LLM com a RPC `consume_llm_rate_limit`.

O teste unitário entrega a `_parse_decision` a linha que ele mesmo inventa, no
formato que o código espera; nome de RPC ou de parâmetro errado, ou a RPC
passando a devolver um objeto em vez de uma lista de uma linha, ficariam
verdes lá. Aqui é a resposta do PostgREST de verdade. Erro desse tipo fecha a
porta (503 em todo disparo), então o risco é de indisponibilidade, e não de
LLM pago sem limite.
"""

import pytest
from fastapi import HTTPException

import services.llm_rate_limiter as llm_rate_limiter
from config import settings

pytestmark = pytest.mark.integration


@pytest.fixture
def limiter(sb, monkeypatch):
    monkeypatch.setattr(llm_rate_limiter, "get_supabase", lambda: sb)
    monkeypatch.setattr(settings, "llm_rate_limit_requests", 1)
    monkeypatch.setattr(settings, "llm_rate_limit_window_seconds", 3600)
    return llm_rate_limiter.enforce_llm_rate_limit


def test_second_dispatch_in_window_gets_429_with_retry_after(
    project, make_user, limiter
):
    user_id = make_user()

    limiter(project["id"], user_id)
    with pytest.raises(HTTPException) as rejected:
        limiter(project["id"], user_id)

    assert rejected.value.status_code == 429
    assert 1 <= int(rejected.value.headers["Retry-After"]) <= 3600
    # O balde não é relido: `llm_rate_limit_buckets` tem REVOKE ALL inclusive
    # para a service_role (só `consume_llm_rate_limit`, SECURITY DEFINER, o
    # toca). O 429 da segunda chamada já prova que o balde foi gravado.


def test_buckets_are_per_user(project, make_user, limiter):
    limiter(project["id"], make_user())

    # Outro usuário no mesmo projeto ainda tem o seu token.
    limiter(project["id"], make_user())
