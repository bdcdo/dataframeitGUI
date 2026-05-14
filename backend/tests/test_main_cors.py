"""Tests for CORS handling in 500 and HTTPException responses."""
from __future__ import annotations

import re

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from main import app


def _boom() -> None:
    raise RuntimeError("kaboom")


def _http_500() -> None:
    raise HTTPException(status_code=500, detail="internal message that should be hidden")


def _http_404() -> None:
    raise HTTPException(status_code=404, detail="not found")


app.add_api_route("/__test_boom__", _boom, methods=["GET"])
app.add_api_route("/__test_http_500__", _http_500, methods=["GET"])
app.add_api_route("/__test_http_404__", _http_404, methods=["GET"])


@pytest.fixture
def client() -> TestClient:
    # raise_server_exceptions=False is critical — otherwise TestClient re-raises
    # the RuntimeError instead of letting the exception handler run.
    return TestClient(app, raise_server_exceptions=False)


def test_match_origin_exact() -> None:
    assert main._match_origin("http://localhost:3000") == "http://localhost:3000"


def test_match_origin_normalizes_case_and_trailing_slash() -> None:
    assert main._match_origin("HTTP://localhost:3000") == "HTTP://localhost:3000"
    assert main._match_origin("http://localhost:3000/") == "http://localhost:3000/"


def test_match_origin_rejects_unauthorized() -> None:
    assert main._match_origin("https://evil.example.com") is None
    assert main._match_origin(None) is None
    assert main._match_origin("") is None


def test_match_origin_regex(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main, "_ORIGIN_REGEX", re.compile(r"https://[a-z0-9-]+\.preview\.example\.com")
    )
    assert (
        main._match_origin("https://pr-42.preview.example.com")
        == "https://pr-42.preview.example.com"
    )
    assert main._match_origin("https://evil.example.com") is None


def test_500_carries_cors_for_authorized_origin(client: TestClient) -> None:
    r = client.get("/__test_boom__", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 500
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert r.headers["access-control-allow-credentials"] == "true"
    assert r.headers["vary"] == "Origin"
    assert r.json() == {"detail": "Internal Server Error"}


def test_500_omits_cors_for_unauthorized_origin(client: TestClient) -> None:
    r = client.get("/__test_boom__", headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 500
    assert "access-control-allow-origin" not in r.headers
    assert r.headers["vary"] == "Origin"
    assert r.json() == {"detail": "Internal Server Error"}


def test_http_exception_5xx_uses_opaque_body(client: TestClient) -> None:
    r = client.get("/__test_http_500__", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 500
    assert r.json() == {"detail": "Internal Server Error"}
    # CORSMiddleware adds these headers since HTTPException responses flow
    # back through it (unlike generic Exception responses).
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "Origin" in r.headers["vary"]


def test_http_exception_4xx_preserves_detail(client: TestClient) -> None:
    r = client.get("/__test_http_404__", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 404
    assert r.json() == {"detail": "not found"}
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
