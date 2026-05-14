"""Tests for justification prompt handling in llm_runner.

Cobre #88 — prompt de justificativa exigente e parametrizável.
"""
from pydantic import BaseModel, Field

from services.llm_runner import (
    DEFAULT_JUSTIFICATION_PROMPT,
    _extend_model_with_justifications,
)


class _Sample(BaseModel):
    plain: str = Field(description="Campo sem prompt custom")
    custom: str = Field(
        description="Campo com prompt custom",
        json_schema_extra={"justification_prompt": "Cite o artigo de lei."},
    )
    templated: str = Field(
        description="Campo com placeholder",
        json_schema_extra={
            "justification_prompt": "Justifique {name} citando o parecer."
        },
    )


def test_default_justification_prompt_demands_citation():
    """O default deve exigir citação textual do trecho do documento."""
    extended = _extend_model_with_justifications(_Sample)
    desc = extended.model_fields["plain_justification"].description
    assert desc == DEFAULT_JUSTIFICATION_PROMPT.format(name="plain")
    # ancoragem no documento — palavras-chave do prompt exigente
    assert "cite" in desc.lower()
    assert "trecho" in desc.lower()
    assert "aspas" in desc.lower()


def test_custom_justification_prompt_is_used():
    extended = _extend_model_with_justifications(_Sample)
    assert (
        extended.model_fields["custom_justification"].description
        == "Cite o artigo de lei."
    )


def test_custom_justification_prompt_supports_name_placeholder():
    extended = _extend_model_with_justifications(_Sample)
    assert (
        extended.model_fields["templated_justification"].description
        == "Justifique templated citando o parecer."
    )


def test_justification_fields_added_for_every_field():
    extended = _extend_model_with_justifications(_Sample)
    for name in ("plain", "custom", "templated"):
        assert f"{name}_justification" in extended.model_fields
        # campos originais preservados
        assert name in extended.model_fields
