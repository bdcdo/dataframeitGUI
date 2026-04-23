"""Testes para _flatten_nested_basemodels e reconstrução aninhada no llm_runner.

O flatten existe para evitar que providers (Gemini em particular) achatem
silenciosamente subfields de BaseModel aninhado no topo do JSON de saída.
Ver services/llm_runner.py.
"""
from typing import Optional

from pydantic import BaseModel, Field

from services.llm_runner import (
    _NESTED_FLATTEN_SEP,
    _flatten_nested_basemodels,
)


class _SubFields(BaseModel):
    doenca: Optional[str] = Field(default=None, description="Nome da doença")
    cid: Optional[str] = Field(default=None, description="CID")


class _RootWithNested(BaseModel):
    q2: str = Field(description="campo simples")
    q5: _SubFields = Field(description="campo aninhado")


class _RootSimple(BaseModel):
    q2: str = Field(description="campo simples")
    q3: str = Field(description="outro simples")


def test_flatten_expands_nested_basemodel():
    flat, field_map = _flatten_nested_basemodels(_RootWithNested)

    # Top-level passa intacto, subfields viram flat
    assert set(flat.model_fields.keys()) == {
        "q2",
        f"q5{_NESTED_FLATTEN_SEP}doenca",
        f"q5{_NESTED_FLATTEN_SEP}cid",
    }
    assert field_map == {
        "q5": [
            (f"q5{_NESTED_FLATTEN_SEP}doenca", "doenca"),
            (f"q5{_NESTED_FLATTEN_SEP}cid", "cid"),
        ]
    }


def test_flatten_skips_models_without_nested():
    flat, field_map = _flatten_nested_basemodels(_RootSimple)
    # Sem nested BaseModels, o original é retornado inalterado
    assert flat is _RootSimple
    assert field_map == {}


def test_flatten_preserves_subfield_descriptions():
    flat, _ = _flatten_nested_basemodels(_RootWithNested)
    doenca_field = flat.model_fields[f"q5{_NESTED_FLATTEN_SEP}doenca"]
    assert doenca_field.description == "Nome da doença"


def _reconstruct_nested(answers: dict, justifications: dict, field_map: dict):
    """Mirror da reconstrução em services.llm_runner.run_llm para permitir
    testar sem montar uma run completa. Manter em sincronia com o runner."""
    for original_name, subs in field_map.items():
        sub_dict = {}
        sub_justs = {}
        for flat_name, sub_name in subs:
            if flat_name in answers:
                sub_dict[sub_name] = answers.pop(flat_name)
            if flat_name in justifications:
                sub_justs[sub_name] = justifications.pop(flat_name)
        if sub_dict:
            answers[original_name] = sub_dict
        if sub_justs:
            justifications[original_name] = "\n".join(
                f"{k}: {v}" for k, v in sub_justs.items()
            )
    return answers, justifications


def test_reconstruction_builds_nested_dict():
    _, field_map = _flatten_nested_basemodels(_RootWithNested)
    answers = {
        "q2": "12345",
        f"q5{_NESTED_FLATTEN_SEP}doenca": "AME tipo 1",
        f"q5{_NESTED_FLATTEN_SEP}cid": "G12.0",
    }
    justifications = {
        f"q5{_NESTED_FLATTEN_SEP}doenca": "Mencionado no parágrafo 2",
        f"q5{_NESTED_FLATTEN_SEP}cid": "CID-10 citado",
    }

    answers, justifications = _reconstruct_nested(answers, justifications, field_map)

    assert answers == {
        "q2": "12345",
        "q5": {"doenca": "AME tipo 1", "cid": "G12.0"},
    }
    # Justification virou string única por campo top-level
    assert justifications == {
        "q5": "doenca: Mencionado no parágrafo 2\ncid: CID-10 citado",
    }


def test_reconstruction_omits_nested_when_all_subfields_missing():
    _, field_map = _flatten_nested_basemodels(_RootWithNested)
    answers = {"q2": "12345"}  # nenhum subfield preenchido
    justifications = {}

    answers, justifications = _reconstruct_nested(answers, justifications, field_map)

    # q5 não é criado se nenhum subfield veio — distingue "ausente" de "vazio"
    assert answers == {"q2": "12345"}
    assert justifications == {}
