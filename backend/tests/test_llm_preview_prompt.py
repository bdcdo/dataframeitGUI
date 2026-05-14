"""Tests for /api/llm/preview-prompt — single source of truth do prompt.

O endpoint só reusa _build_prompt; estes testes garantem que a rota
encaminha description + template e que o resultado bate com a função
usada na execução real (sem a cópia hardcoded do frontend defasar).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from main import app
from services.llm_runner import _build_prompt


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_preview_matches_build_prompt(client: TestClient) -> None:
    payload = {
        "project_description": "Estudo sobre liminares em saúde.",
        "prompt_template": "Foque no dispositivo da decisão.",
    }
    r = client.post("/api/llm/preview-prompt", json=payload)
    assert r.status_code == 200
    assert r.json() == {
        "prompt": _build_prompt(
            payload["project_description"], payload["prompt_template"]
        )
    }


def test_preview_omits_optional_sections_when_blank(client: TestClient) -> None:
    r = client.post(
        "/api/llm/preview-prompt",
        json={"project_description": "  ", "prompt_template": ""},
    )
    assert r.status_code == 200
    prompt = r.json()["prompt"]
    assert "## Contexto do estudo" not in prompt
    assert "## Instrucoes adicionais" not in prompt
    assert "## Instrucoes gerais" in prompt


def test_preview_accepts_missing_fields(client: TestClient) -> None:
    r = client.post("/api/llm/preview-prompt", json={})
    assert r.status_code == 200
    assert r.json()["prompt"] == _build_prompt(None, None)
