"""Contrato do backend com a outbox da auto-revisão.

O backend só lê a outbox: confere na subida que a migration existe
(`auto_review_reconciliation_capability`) e, a cada tick, se há pedido vencido
(`next_attempt_at <= agora`). Os testes unitários trocam o cliente por um fake
que devolve o que o teste manda. Aqui as duas leituras rodam contra o Supabase
local, e o pedido nasce do caminho real: a publicação de uma resposta LLM
completa, cujo trigger grava a outbox.

A sonda olha a outbox inteira, sem filtro de projeto, como em produção. Para
não depender do que outras suítes deixaram no banco, o pedido deste teste é
empurrado para o ano 2000 e a pergunta é feita em volta dessa data.
"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

import services.auto_review_reconciliation as reconciliation
from config import settings

pytestmark = pytest.mark.integration

DUE_AT = datetime(2000, 1, 1, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _real_client(sb, monkeypatch):
    monkeypatch.setattr(reconciliation, "get_supabase", lambda: sb)


def test_capability_check_accepts_the_migrated_database(monkeypatch):
    # A checagem recusa antes de consultar quando falta a configuração.
    monkeypatch.setattr(settings, "supabase_url", "http://127.0.0.1")
    monkeypatch.setattr(settings, "supabase_service_key", "contrato")

    reconciliation.assert_auto_review_reconciliation_capability()


def test_due_probe_sees_request_from_llm_publication(sb, project, make_document):
    doc_id = make_document()
    sb.rpc(
        "publish_latest_llm_response",
        {
            "p_response": {
                "project_id": project["id"],
                "document_id": doc_id,
                "round_id": project["current_round_id"],
                "respondent_name": "google_genai/gemini-contrato",
                "answers": {"resposta": "sim"},
                "is_partial": False,
            }
        },
    ).execute()
    sb.table("auto_review_reconciliation_requests").update(
        {"next_attempt_at": DUE_AT.isoformat()}
    ).eq("document_id", doc_id).execute()

    def due(now: datetime) -> bool:
        return asyncio.run(
            reconciliation.has_due_auto_review_reconciliation_request(now=now)
        )

    assert due(DUE_AT) is True
    assert due(DUE_AT - timedelta(seconds=1)) is False
