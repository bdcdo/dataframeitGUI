"""Fixtures dos contratos do backend contra o Supabase local.

Os testes daqui rodam com um `supabase.Client` de verdade, em vez dos fakes em
memória dos testes unitários, que aceitam qualquer coluna, RPC ou parâmetro e
por isso repetem o contrato em vez de verificá-lo (#673/#674). Como rodar e por
que ficam fora do `pytest -q`: ver test_llm_runs_persistence.py.
"""

import os
import uuid
from collections.abc import Callable, Iterator
from urllib.parse import urlparse

import pytest
from supabase import Client, create_client

URL_ENV = "INTEGRATION_SUPABASE_URL"
KEY_ENV = "INTEGRATION_SUPABASE_SERVICE_KEY"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


@pytest.fixture(scope="module")
def sb() -> Client:
    url = os.environ.get(URL_ENV, "")
    key = os.environ.get(KEY_ENV, "")
    # Falha, e não skip: um gate que pula por falta de ambiente fica verde
    # sem ter testado nada.
    if not url or not key:
        pytest.fail(
            f"{URL_ENV} e {KEY_ENV} não definidas — rode por "
            "`npm run test:db:llm-runs-contract`, com o Supabase local no ar."
        )
    # Os testes escrevem e apagam linhas com a service key. Só contra o stack
    # local: uma URL de produção esquecida no ambiente não pode passar daqui.
    if urlparse(url).hostname not in LOOPBACK_HOSTS:
        pytest.fail(f"{URL_ENV} precisa apontar para o Supabase local, não {url}")
    return create_client(url, key)


@pytest.fixture
def _created_users(sb: Client) -> Iterator[list[str]]:
    """Usuários criados por `make_user`, apagados depois do projeto.

    `project` depende desta fixture para que o pytest a desmonte por último
    (ordem inversa da montagem): `projects.created_by` e
    `schema_change_log.changed_by` referenciam o profile sem cascade, então o
    usuário só sai depois do projeto que o cita.
    """
    created: list[str] = []
    yield created
    for user_id in created:
        sb.auth.admin.delete_user(user_id)


@pytest.fixture
def project(sb: Client, _created_users):
    """Projeto descartável; o trigger de INSERT cria a rodada corrente."""
    project_id = str(uuid.uuid4())
    sb.table("projects").insert(
        {"id": project_id, "name": f"contrato backend {project_id}"}
    ).execute()
    try:
        row = (
            sb.table("projects")
            .select("id, current_round_id")
            .eq("id", project_id)
            .single()
            .execute()
            .data
        )
        assert row["current_round_id"], "trigger não criou a rodada inicial"
        yield row
    finally:
        # O cascade de projects leva rounds, documentos, respostas, membros,
        # llm_runs, outbox e histórico de schema junto.
        sb.table("projects").delete().eq("id", project_id).execute()


@pytest.fixture
def make_document(sb: Client, project) -> Callable[[], str]:
    """Documentos do projeto da fixture (apagados pelo cascade do projeto)."""

    def make() -> str:
        return (
            sb.table("documents")
            .insert({"project_id": project["id"], "text": "documento de contrato"})
            .execute()
            .data[0]["id"]
        )

    return make


@pytest.fixture
def make_user(sb: Client, _created_users) -> Callable[[], str]:
    """Usuários pela Auth Admin API; o trigger de auth.users cria o profile."""

    def make() -> str:
        user = sb.auth.admin.create_user(
            {
                "email": f"contrato-{uuid.uuid4()}@example.test",
                "email_confirm": True,
            }
        ).user
        _created_users.append(user.id)
        return user.id

    return make
