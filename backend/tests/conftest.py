"""Fixtures compartilhadas dos testes do backend.

As rotas exigem JWT (services/auth.py), e a suíte roda na mesma configuração
de produção: RS256 com JWKS e issuer. O JWKS é falso (sem rede) e devolve a
pública de `TEST_RSA_PRIVATE_KEY`, com que os testes assinam os tokens.
"""

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

import services.auth as auth_mod
from config import settings

# Gerada uma vez por sessão (RSA-2048 é caro).
TEST_RSA_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
TEST_ISSUER = "https://clerk.test-prod.example/"
TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


def use_jwks_key(monkeypatch, public_key) -> None:
    """Faz o JWKS falso devolver `public_key` para qualquer token."""
    fake_client = SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=public_key)
    )
    monkeypatch.setattr(auth_mod, "_get_jwks_client", lambda: fake_client)


@pytest.fixture(autouse=True)
def _auth_rs256(monkeypatch):
    monkeypatch.setattr(settings, "clerk_jwks_url", "https://clerk.test/jwks.json")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", TEST_ISSUER)
    use_jwks_key(monkeypatch, TEST_RSA_PRIVATE_KEY.public_key())


@pytest.fixture
def auth_headers() -> dict[str, str]:
    token = jwt.encode(
        {
            "supabase_uid": TEST_USER_ID,
            "iss": TEST_ISSUER,
            "exp": int(time.time()) + 3600,
        },
        TEST_RSA_PRIVATE_KEY,
        algorithm="RS256",
    )
    return {"Authorization": f"Bearer {token}"}
