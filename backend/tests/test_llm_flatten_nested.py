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


class _SubFieldsRequired(BaseModel):
    doenca: Optional[str] = Field(
        default=None,
        description="Nome da doença",
        json_schema_extra={"subfield_required": True},
    )


class _RootWithRequiredSubfield(BaseModel):
    q5: _SubFieldsRequired = Field(description="campo aninhado")


def test_flatten_does_not_leak_reserved_json_schema_keyword():
    """O extra do subcampo sobe para property do schema mandado ao provider.

    `_flatten_nested_basemodels` reaproveita o FieldInfo do subcampo inteiro,
    então qualquer chave de `json_schema_extra` vira chave da property no JSON
    Schema. `required` é palavra reservada ali (vale no nível do objeto, e como
    array de strings), por isso o gerador emite `subfield_required` — ver
    generatePydanticCode e _extract_subfields (issue #491).
    """
    flat, _ = _flatten_nested_basemodels(_RootWithRequiredSubfield)
    prop = flat.model_json_schema()["properties"][f"q5{_NESTED_FLATTEN_SEP}doenca"]

    assert "required" not in prop
    assert prop["subfield_required"] is True


class _SubFieldsMixed(BaseModel):
    part_a: str = Field(description="Parte A")
    part_b: Optional[str] = Field(default=None, description="Parte B")


class _RootWithConditionalNested(BaseModel):
    q2: str = Field(description="campo simples")
    doc: Optional[_SubFieldsMixed] = Field(
        default=None,
        description="Doc",
        json_schema_extra={"visible_if": {"field": "q2", "equals": "Sim"}},
    )


class _RootWithRequiredParentMixed(BaseModel):
    doc: _SubFieldsMixed = Field(description="Doc")


def test_flatten_unwraps_optional_nested_basemodel():
    """Composto com condição sai do gerador como `Optional[_x_fields]` (#525)."""
    flat, field_map = _flatten_nested_basemodels(_RootWithConditionalNested)

    sep = _NESTED_FLATTEN_SEP
    assert set(flat.model_fields) == {"q2", f"doc{sep}part_a", f"doc{sep}part_b"}
    assert field_map == {
        "doc": [(f"doc{sep}part_a", "part_a"), (f"doc{sep}part_b", "part_b")]
    }


def test_flatten_makes_subfields_of_optional_parent_optional():
    """O pai opcional podia vir nulo inteiro; seus subcampos achatados também.

    Senão um pai oculto com subcampo `str` obrigatório obrigaria o LLM a
    inventar um valor que a poda condicional jogaria fora.
    """
    flat, _ = _flatten_nested_basemodels(_RootWithConditionalNested)
    part_a = flat.model_fields[f"doc{_NESTED_FLATTEN_SEP}part_a"]

    assert not part_a.is_required()
    assert part_a.default is None
    assert part_a.description == "Parte A"
    assert flat(q2="Não").model_dump() == {
        "q2": "Não",
        f"doc{_NESTED_FLATTEN_SEP}part_a": None,
        f"doc{_NESTED_FLATTEN_SEP}part_b": None,
    }


def test_flatten_keeps_required_subfield_of_required_parent():
    flat, _ = _flatten_nested_basemodels(_RootWithRequiredParentMixed)
    assert flat.model_fields[f"doc{_NESTED_FLATTEN_SEP}part_a"].is_required()


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
