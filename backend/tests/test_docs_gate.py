"""Garante o gate dos endpoints de documentação (/docs, /redoc, /openapi.json).

O gate é fail-safe (config.py: enable_docs=False por default). Os testes
constroem o app via `create_app(enable_docs=...)`, então travam a propriedade
de segurança de forma independente do ambiente do processo — um dev que ligou o
Swagger local com ENABLE_DOCS=true no .env não faz este teste falhar (o app de
produção usa `settings.enable_docs`, mas aqui o valor é passado explícito).

Um /openapi.json anônimo vazaria o schema de todas as rotas protegidas num
serviço internet-facing (issue #337); por isso o lado fechado é o invariante.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from main import create_app

DOC_PATHS = ["/openapi.json", "/docs", "/redoc"]


@pytest.mark.parametrize("path", DOC_PATHS)
def test_docs_endpoints_closed_when_disabled(path: str) -> None:
    client = TestClient(create_app(enable_docs=False))
    assert client.get(path).status_code == 404


@pytest.mark.parametrize("path", DOC_PATHS)
def test_docs_endpoints_open_when_enabled(path: str) -> None:
    client = TestClient(create_app(enable_docs=True))
    assert client.get(path).status_code == 200
