"""Strict validation for every request entering ``backend/routes``."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from main import app
from routes.llm_routes import RunRequest
from services.auth import AuthUser, require_authenticated_user

PROJECT_ID = "22222222-2222-2222-2222-222222222222"
DOCUMENT_ID = "33333333-3333-3333-3333-333333333333"


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[require_authenticated_user] = lambda: AuthUser(
        id="11111111-1111-1111-1111-111111111111"
    )
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.pop(require_authenticated_user, None)


def test_every_api_request_body_uses_strict_model() -> None:
    schema = app.openapi()
    checked: set[str] = set()
    for path, operations in schema["paths"].items():
        if not path.startswith("/api/"):
            continue
        for operation in operations.values():
            request_body = operation.get("requestBody")
            if request_body is None:
                continue
            model_ref = request_body["content"]["application/json"]["schema"]["$ref"]
            model_name = model_ref.rsplit("/", 1)[-1]
            model_schema = schema["components"]["schemas"][model_name]
            assert model_schema["additionalProperties"] is False, path
            checked.add(path)

    assert checked == {
        "/api/llm/run",
        "/api/llm/preview-prompt",
        "/api/llm/cleanup-stale",
        "/api/pydantic/recover-fields",
    }


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/llm/run", {"project_id": PROJECT_ID, "unknown": True}),
        ("/api/llm/preview-prompt", {"unknown": True}),
        ("/api/llm/cleanup-stale", {"project_id": PROJECT_ID, "unknown": True}),
        (
            "/api/pydantic/recover-fields",
            {"project_id": PROJECT_ID, "unknown": True},
        ),
    ],
)
def test_every_request_body_rejects_unknown_fields(
    client: TestClient, path: str, payload: dict
) -> None:
    response = client.post(path, json=payload)
    assert response.status_code == 422
    assert response.json()["detail"][0]["type"] == "extra_forbidden"


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/llm/run", {"project_id": "not-a-uuid"}),
        (
            "/api/llm/run",
            {"project_id": PROJECT_ID, "document_ids": []},
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "document_ids": [DOCUMENT_ID, DOCUMENT_ID],
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "random_sample",
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "max_responses",
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "random_sample",
                "sample_size": "5",
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "random_sample",
                "sample_size": True,
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "random_sample",
                "sample_size": 10_001,
            },
        ),
        (
            "/api/llm/run",
            {
                "project_id": PROJECT_ID,
                "filter_mode": "max_responses",
                "max_response_count": 1_001,
            },
        ),
        (
            "/api/llm/preview-prompt",
            {"prompt_template": "x" * 50_001},
        ),
        ("/api/llm/status/not-a-uuid", None),
    ],
)
def test_invalid_boundaries_return_consistent_422(
    client: TestClient, path: str, payload: dict | None
) -> None:
    response = client.get(path) if payload is None else client.post(path, json=payload)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], list)


def test_document_list_has_explicit_upper_bound() -> None:
    document_ids = [uuid.UUID(int=index + 1) for index in range(10_001)]
    with pytest.raises(ValidationError, match="at most 10000 items"):
        RunRequest(project_id=PROJECT_ID, document_ids=document_ids)


def test_run_field_route_does_not_exist(client: TestClient) -> None:
    # A rota prometia rodar só os campos de `field_names`, rodava o schema
    # inteiro e pulava a guarda de somente-leitura da impersonação (#746).
    # Sem chamador, foi removida: quem a chamar recebe 404 antes de qualquer
    # autorização, rate limit ou job.
    response = client.post(
        "/api/llm/run-field",
        json={"project_id": PROJECT_ID, "field_names": ["q1"]},
    )
    assert response.status_code == 404
