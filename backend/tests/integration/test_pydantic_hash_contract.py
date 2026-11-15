"""Contrato do `projects.pydantic_hash` entre o runner e o banco.

Dois escritores calculam o mesmo hash por caminhos diferentes: o banco, em
`commit_project_schema`, ao salvar o schema (`substring(encode(digest(code,
'sha256'), 'hex') FROM 1 FOR 16)`), e o runner, em Python, que carimba o hash em
cada resposta LLM e o regrava em `projects` ao fim da run. Se as duas regras
divergirem (outra codificação do texto, outro corte), nada falha: o runner
troca o hash do projeto, e as respostas legadas, que só se ligam ao schema por
ele, saem da fila de Comparação (ver o CLAUDE.md, "Cuidado com o
pydantic_hash"). Os fakes dos testes unitários não calculam o lado do banco.

O código de teste tem acento e emoji de propósito: é onde uma codificação
diferente de UTF-8 divergiria.
"""

import pytest
from supabase import Client

from services.llm_runner import _persist_project_pydantic_hash, _pydantic_code_hash

pytestmark = pytest.mark.integration

CODE = (
    "class Analysis(BaseModel):\n"
    '    """Decisão — ação ✓ 🧪"""\n'
    '    resposta: str = Field(description="É válido?")\n'
)
FIELDS = [{"id": "00000000-0000-4000-8000-0000000000a1", "name": "resposta"}]


def _schema_state(sb: Client, project_id: str) -> dict:
    return (
        sb.table("projects")
        .select(
            "pydantic_hash, schema_revision, schema_version_major, "
            "schema_version_minor, schema_version_patch"
        )
        .eq("id", project_id)
        .single()
        .execute()
        .data
    )


def _commit_schema(sb: Client, project_id: str, author_id: str) -> None:
    """Salva CODE pelo caminho do frontend (a RPC calcula o hash no banco)."""
    state = _schema_state(sb, project_id)
    result = sb.rpc(
        "commit_project_schema",
        {
            "p_project_id": project_id,
            "p_expected_revision": state["schema_revision"],
            "p_pydantic_fields": FIELDS,
            "p_pydantic_code": CODE,
            "p_version_major": state["schema_version_major"],
            "p_version_minor": state["schema_version_minor"] + 1,
            "p_version_patch": 0,
            "p_change_type": "minor",
            "p_log_entries": [
                {
                    "field_name": "resposta",
                    "change_summary": "adicionado",
                    "before_value": {},
                    "after_value": {"name": "resposta"},
                }
            ],
            "p_changed_by": author_id,
        },
    ).execute()
    assert result.data and result.data[0]["status"] == "saved", result.data


def test_runner_hash_equals_hash_stored_by_schema_save(sb, project, make_user):
    _commit_schema(sb, project["id"], make_user())

    stored = _schema_state(sb, project["id"])
    assert stored["pydantic_hash"] == _pydantic_code_hash(CODE)


def test_runner_write_keeps_hash_and_schema_revision(sb, project, make_user):
    """A regravação do fim da run não muda nada num projeto salvo pela GUI."""
    _commit_schema(sb, project["id"], make_user())
    before = _schema_state(sb, project["id"])

    _persist_project_pydantic_hash(sb, project["id"], _pydantic_code_hash(CODE))

    assert _schema_state(sb, project["id"]) == before


def test_runner_write_lands_without_new_schema_revision(sb, project):
    """O hash fica fora da identidade do schema: o runner o grava sozinho.

    `enforce_project_schema_revision` recusa mudança de schema sem +1 na
    revisão. Se `pydantic_hash` entrasse nessa identidade, a escrita do runner
    falharia ao fim de toda run, depois de o LLM já ter sido pago.
    """
    before = _schema_state(sb, project["id"])
    new_hash = _pydantic_code_hash(CODE)
    assert before["pydantic_hash"] != new_hash

    _persist_project_pydantic_hash(sb, project["id"], new_hash)

    after = _schema_state(sb, project["id"])
    assert after == {**before, "pydantic_hash": new_hash}
