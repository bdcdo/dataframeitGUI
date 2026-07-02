"""Garante que os endpoints de documentação ficam fechados por padrão.

O gate é fail-safe (config.py: enable_docs=False por default). Como `app` é
instanciado no import de main.py com esse default, o app sob teste já sobe com
/docs, /redoc e /openapi.json desligados. Estes testes travam essa propriedade
de segurança contra regressões — um /openapi.json anônimo vazaria o schema de
todas as rotas protegidas num serviço internet-facing (issue #337).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
def test_docs_endpoints_closed_by_default(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404
