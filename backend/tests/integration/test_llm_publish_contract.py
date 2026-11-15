"""Contrato da publicação de respostas LLM (`publish_latest_llm_response`).

O runner monta a resposta em `_build_llm_response_row` e a manda inteira, como
um jsonb, para a RPC, que lê chave por chave (`p_response->>'...'`). Chave
renomeada de um lado só não dá erro: a RPC lê NULL e grava o default da coluna
(versão 0.1.0, `llm_job_id` nulo, sem `pydantic_hash`). Os testes de `run_llm`
usam um fake que aceita qualquer nome de RPC e qualquer payload, então nada ali
pega isso. Aqui o envio passa por `_RowPublisher._send` (o nome da RPC e do
parâmetro são os do runner) contra o Supabase local, e cada chave do payload é
relida da coluna de mesmo nome.

Os valores de versão e de hash fogem do default de propósito: com eles, uma
chave que a RPC deixasse de ler reprovaria a releitura.
"""

import uuid

import pytest
from pydantic import BaseModel
from supabase import Client

from services.llm_runner import (
    _build_llm_response_row,
    _PreparedLlmModel,
    _RowPublisher,
    _RunMetadata,
)

pytestmark = pytest.mark.integration


class _Analysis(BaseModel):
    resposta: str


def _run(project: dict, round_id: str | None = None) -> _RunMetadata:
    return _RunMetadata(
        project_id=project["id"],
        round_id=round_id or project["current_round_id"],
        llm_provider="google_genai",
        llm_model="gemini-contrato",
        pydantic_hash="0123456789abcdef",
        answer_field_hashes={"resposta": "aaaaaaaaaaaa"},
        schema_version_major=2,
        schema_version_minor=3,
        schema_version_patch=4,
    )


def _publish(
    sb: Client,
    run: _RunMetadata,
    doc_id: str,
    *,
    is_partial: bool = False,
) -> tuple[_RowPublisher, dict]:
    job_id = str(uuid.uuid4())
    publisher = _RowPublisher(
        sb, job_id, {}, _PreparedLlmModel(_Analysis, {}, {}), 0.5, run
    )
    response = _build_llm_response_row(
        run=run,
        doc_id=doc_id,
        answers={"resposta": "sim"},
        justifications={"resposta": "trecho citado"},
        is_partial=is_partial,
        job_id=job_id,
        llm_error_msg="cobertura baixa" if is_partial else None,
    )
    publisher._send(doc_id, response)
    return publisher, response


def _llm_rows(sb: Client, doc_id: str, columns: str) -> list[dict]:
    return (
        sb.table("responses")
        .select(f"id, {columns}")
        .eq("document_id", doc_id)
        .eq("respondent_type", "llm")
        .order("created_at")
        .execute()
        .data
    )


def _outbox(sb: Client, doc_id: str) -> list[dict]:
    return (
        sb.table("auto_review_reconciliation_requests")
        .select("llm_response_id, project_id")
        .eq("document_id", doc_id)
        .execute()
        .data
    )


def test_every_payload_key_lands_in_its_column(sb, project, make_document):
    doc_id = make_document()

    publisher, response = _publish(sb, _run(project), doc_id)

    assert publisher.outcome().publish_failures == []
    [row] = _llm_rows(sb, doc_id, ", ".join(response))
    assert {key: row[key] for key in response} == response
    # Efeito da RPC além da linha: a resposta completa entra na outbox da
    # auto-revisão (trigger de responses) apontando para ela.
    assert _outbox(sb, doc_id) == [
        {"llm_response_id": row["id"], "project_id": project["id"]}
    ]


def test_new_publication_demotes_previous_latest(sb, project, make_document):
    doc_id = make_document()

    _publish(sb, _run(project), doc_id)
    _publish(sb, _run(project), doc_id)

    first, second = _llm_rows(sb, doc_id, "is_latest")
    assert (first["is_latest"], second["is_latest"]) == (False, True)
    assert _outbox(sb, doc_id)[0]["llm_response_id"] == second["id"]


def test_partial_response_is_kept_out_of_latest_and_outbox(sb, project, make_document):
    doc_id = make_document()

    publisher, response = _publish(sb, _run(project), doc_id, is_partial=True)

    assert publisher.outcome().publish_failures == []
    [row] = _llm_rows(sb, doc_id, "is_latest, is_partial, llm_error")
    assert {k: row[k] for k in ("is_latest", "is_partial", "llm_error")} == {
        "is_latest": False,
        "is_partial": True,
        "llm_error": response["llm_error"],
    }
    assert _outbox(sb, doc_id) == []


def test_stale_round_aborts_the_run_with_reserved_sqlstate(sb, project, make_document):
    """O runner reconhece o P0R01 da RPC e aborta, em vez de contar falha de linha.

    Se o SQLSTATE do banco e `_ROUND_CHANGED_SQLSTATE` divergirem, a run segue
    publicando numa rodada que já não é a corrente, uma linha recusada por vez.
    """
    doc_id = make_document()
    stale_round = (
        sb.table("rounds")
        .insert({"project_id": project["id"], "label": "rodada não corrente"})
        .execute()
        .data[0]["id"]
    )

    with pytest.raises(RuntimeError, match="deixou de ser a corrente"):
        _publish(sb, _run(project, round_id=stale_round), doc_id)

    assert _llm_rows(sb, doc_id, "is_latest") == []
