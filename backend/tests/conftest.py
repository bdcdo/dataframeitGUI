"""Fixtures compartilhadas dos testes do backend.

Desde que as rotas passaram a exigir JWT (services/auth.py), os testes que
batem na API via TestClient precisam de um secret HS256 configurado e de um
header `Authorization: Bearer` válido.
"""

import time

import jwt
import pytest

from config import settings

# >= 32 bytes para não disparar o aviso de comprimento de chave do pyjwt.
TEST_JWT_SECRET = "conftest-secret-0123456789-abcdefghij-klmnop"
TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture(autouse=True)
def _auth_secret(monkeypatch):
    monkeypatch.setattr(settings, "supabase_jwt_secret", TEST_JWT_SECRET)
    monkeypatch.setattr(settings, "clerk_jwks_url", "")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    monkeypatch.setattr(settings, "clerk_jwt_audience", "")


@pytest.fixture
def auth_headers() -> dict[str, str]:
    token = jwt.encode(
        {"supabase_uid": TEST_USER_ID, "exp": int(time.time()) + 3600},
        TEST_JWT_SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}
