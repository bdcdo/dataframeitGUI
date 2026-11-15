"""Contrato das checagens de autorização do backend com as tabelas reais.

O backend usa a service key, que ignora a RLS, então `services/auth.py` refaz
a regra de acesso consultando `master_users`, `projects.created_by`,
`project_members` e `llm_runs`. Os testes unitários respondem a essas
consultas com um fake que devolve o que o teste manda, sem conferir tabela,
coluna nem valor de `role`. Aqui as consultas rodam contra o Supabase local,
com um usuário em cada papel.
"""

import uuid

import pytest
from fastapi import HTTPException

import services.auth as auth
from services.auth import AuthUser, require_job_access, require_project_coordinator
from services.llm_runner import _persist_run_insert

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _real_client(sb, monkeypatch):
    monkeypatch.setattr(auth, "get_supabase", lambda: sb)


def _member(sb, project_id: str, user_id: str, role: str) -> None:
    sb.table("project_members").insert(
        {"project_id": project_id, "user_id": user_id, "role": role}
    ).execute()


def _status(check) -> int:
    """200 quando autoriza, senão o status do HTTPException."""
    try:
        check()
    except HTTPException as exc:
        return exc.status_code
    return 200


@pytest.fixture
def people(sb, project, make_user):
    ids = {
        name: make_user()
        for name in ("coordinator", "researcher", "creator", "master", "outsider")
    }
    _member(sb, project["id"], ids["coordinator"], "coordenador")
    _member(sb, project["id"], ids["researcher"], "pesquisador")
    sb.table("projects").update({"created_by": ids["creator"]}).eq(
        "id", project["id"]
    ).execute()
    # master_users cai em cascade com o profile, no teardown de make_user.
    sb.table("master_users").insert({"user_id": ids["master"]}).execute()
    return ids


def test_coordinator_gate_follows_role_creator_and_master(project, people):
    statuses = {
        name: _status(
            lambda u=user_id: require_project_coordinator(project["id"], AuthUser(u))
        )
        for name, user_id in people.items()
    }

    assert statuses == {
        "coordinator": 200,
        "researcher": 403,
        "creator": 200,
        "master": 200,
        "outsider": 403,
    }


def test_job_access_is_for_any_member_and_hides_other_projects(sb, project, people):
    job_id = str(uuid.uuid4())
    _persist_run_insert(sb, job_id, project["id"], "pending")

    statuses = {
        name: _status(lambda u=user_id: require_job_access(job_id, AuthUser(u)))
        for name, user_id in people.items()
    }

    assert statuses == {
        "coordinator": 200,
        "researcher": 200,
        "creator": 200,
        "master": 200,
        "outsider": 404,
    }
    unknown_job = str(uuid.uuid4())
    assert (
        _status(lambda: require_job_access(unknown_job, AuthUser(people["master"])))
        == 404
    )
