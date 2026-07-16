"""Integration contract between group validators and dataframeit retries."""

import pytest
from dataframeit.llm import LLMConfig, call_langchain
from pydantic import BaseModel, Field, ValidationError

from services.llm_runner import _flatten_nested_basemodels


class _Subfields(BaseModel):
    evidence: str = Field(description="Evidência")


class _Analysis(BaseModel):
    details: _Subfields = Field(
        description="Detalhes",
        json_schema_extra={"subfield_rule": "all"},
    )


def test_dataframeit_retries_when_group_validator_rejects_structured_output(
    monkeypatch,
):
    flat_model, _ = _flatten_nested_basemodels(_Analysis)
    attempts: list[dict] = []

    class _StructuredLlm:
        def invoke(self, _prompt):
            payload = {} if not attempts else {"details__evidence": "trecho"}
            attempts.append(payload)
            try:
                parsed = flat_model.model_validate(payload)
            except ValidationError as exc:
                return {"parsing_error": exc, "parsed": None, "raw": None}
            return {"parsing_error": None, "parsed": parsed, "raw": None}

    class _FakeLlm:
        def with_structured_output(self, model, *, include_raw):
            assert model is flat_model
            assert include_raw is True
            return _StructuredLlm()

    monkeypatch.setattr(
        "dataframeit.llm._create_langchain_llm",
        lambda *_args, **_kwargs: _FakeLlm(),
    )
    config = LLMConfig(
        model="fake",
        provider="fake",
        api_key=None,
        max_retries=2,
        base_delay=0,
        max_delay=0,
        rate_limit_delay=0,
    )

    with pytest.warns(UserWarning, match="Tentativa 1/2 falhou"):
        result = call_langchain("documento", flat_model, "{texto}", config)

    assert attempts == [{}, {"details__evidence": "trecho"}]
    assert result["data"]["details__evidence"] == "trecho"
    assert result["_retry_info"]["retries"] == 1
