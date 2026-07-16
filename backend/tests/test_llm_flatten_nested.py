"""Group-contract tests for nested Pydantic models sent through dataframeit."""

from typing import Literal, Optional

import pytest
from pydantic import BaseModel, Field, ValidationError

from services.llm_runner import (
    _NESTED_FLATTEN_SEP,
    _NOT_INFORMED_SENTINEL,
    _expected_llm_fields,
    _extend_model_with_justifications,
    _flatten_nested_basemodels,
    _generated_justification_fields,
    _prepare_llm_model,
    _reconstruct_nested_answers,
)


class _SubFields(BaseModel):
    doenca: Optional[str] = Field(default=None, description="Nome da doença")
    cid: Optional[str] = Field(default=None, description="CID")


class _RootWithNested(BaseModel):
    q2: str = Field(description="campo simples")
    q5: _SubFields = Field(description="campo aninhado")


class _RootWithOptionalNested(BaseModel):
    q5: Optional[_SubFields] = Field(
        default=None,
        description="campo aninhado opcional",
        json_schema_extra={"required": False},
    )


class _RootSimple(BaseModel):
    q2: str = Field(description="campo simples")
    q3: str = Field(description="outro simples")


def test_flatten_expands_nested_basemodel_with_sentinel_and_typed_specs():
    flat, specs = _flatten_nested_basemodels(_RootWithNested)

    assert set(flat.model_fields) == {
        "q2",
        "q5",
        f"q5{_NESTED_FLATTEN_SEP}doenca",
        f"q5{_NESTED_FLATTEN_SEP}cid",
    }
    assert len(specs) == 1
    assert specs[0].name == "q5"
    assert specs[0].sentinel_field_name == "q5"
    assert [subfield.name for subfield in specs[0].subfields] == ["doenca", "cid"]
    assert flat.model_fields["q5"].is_required() is False
    assert _NOT_INFORMED_SENTINEL in flat.model_fields["q5"].description


def test_flatten_recognizes_optional_nested_model():
    flat, specs = _flatten_nested_basemodels(_RootWithOptionalNested)

    assert len(specs) == 1
    assert specs[0].required is False
    assert f"q5{_NESTED_FLATTEN_SEP}doenca" in flat.model_fields


def test_preparation_derives_group_contract_from_compiled_code_not_project_json():
    code = """from typing import Optional
from pydantic import BaseModel, Field

class Details(BaseModel):
    primary: Optional[str] = Field(default=None, json_schema_extra={"subfield_required": True})
    other: Optional[str] = Field(default=None)

class Analysis(BaseModel):
    details: Details = Field(json_schema_extra={"subfield_rule": "at_least_one"})
"""
    misleading_project_json = [
        {
            "name": "details",
            "required": False,
            "subfield_rule": "all",
            "subfields": [{"key": "primary", "required": False}],
        }
    ]

    prepared = _prepare_llm_model(code, misleading_project_json, False)

    assert prepared.nested_fields[0].required is True
    assert prepared.nested_fields[0].rule == "at_least_one"
    assert prepared.nested_fields[0].subfields[0].required is True
    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        prepared.model_class.model_validate({})


def test_flatten_skips_models_without_nested():
    flat, specs = _flatten_nested_basemodels(_RootSimple)

    assert flat is _RootSimple
    assert specs == ()


def test_flatten_preserves_subfield_description_and_documents_group_contract():
    flat, _ = _flatten_nested_basemodels(_RootWithNested)

    doenca = flat.model_fields[f"q5{_NESTED_FLATTEN_SEP}doenca"]
    assert doenca.description.startswith("Nome da doença")
    assert _NOT_INFORMED_SENTINEL in doenca.description
    assert _NOT_INFORMED_SENTINEL in flat.model_json_schema()["description"]


def test_flatten_rejects_generated_name_collision():
    class Collision(BaseModel):
        q5: _SubFields
        q5__doenca: str

    with pytest.raises(ValueError, match="q5__doenca.*colide"):
        _flatten_nested_basemodels(Collision)


class _AllSubfields(BaseModel):
    title: str = Field(description="Título")
    note: Optional[str] = Field(default=None, description="Nota")


class _RootWithOptionalNestedAndRequiredSubfield(BaseModel):
    details: Optional[_AllSubfields] = Field(
        default=None,
        json_schema_extra={"required": False, "subfield_rule": "all"},
    )


class _RequiredAll(BaseModel):
    details: _AllSubfields = Field(
        description="Detalhes", json_schema_extra={"subfield_rule": "all"}
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"details__title": "   "},
        {"details__note": "parcial"},
    ],
)
def test_required_all_rejects_missing_required_subfields(payload):
    flat, _ = _flatten_nested_basemodels(_RequiredAll)

    with pytest.raises(ValidationError, match="details.*title"):
        flat.model_validate(payload)


def test_required_all_accepts_required_subfields_or_sentinel():
    flat, _ = _flatten_nested_basemodels(_RequiredAll)

    assert flat.model_validate({"details__title": "Decisão"})
    assert flat.model_validate({"details": _NOT_INFORMED_SENTINEL})


class _NoRequiredSubfields(BaseModel):
    first: Optional[str] = None
    second: Optional[str] = None


class _RequiredAllWithoutIndividualRequirements(BaseModel):
    details: _NoRequiredSubfields = Field(json_schema_extra={"subfield_rule": "all"})


def test_required_all_without_required_subfields_still_requires_one_value():
    flat, _ = _flatten_nested_basemodels(_RequiredAllWithoutIndividualRequirements)

    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        flat.model_validate({})
    assert flat.model_validate({"details__second": "valor"})


class _AtLeastOneSubfields(BaseModel):
    dormant_required: Optional[str] = Field(
        default=None,
        json_schema_extra={"subfield_required": True},
    )
    other: Optional[str] = None


class _RequiredAtLeastOne(BaseModel):
    details: _AtLeastOneSubfields = Field(
        json_schema_extra={"subfield_rule": "at_least_one"}
    )


def test_at_least_one_ignores_individual_required_flag_but_requires_content():
    flat, _ = _flatten_nested_basemodels(_RequiredAtLeastOne)

    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        flat.model_validate({"details__other": "  "})
    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        flat.model_validate({"unknown": "não conta"})
    with pytest.raises(ValidationError):
        flat.model_validate({"details__other": {"malformed": True}})
    assert flat.model_validate({"details__other": "valor"})


def test_optional_parent_allows_empty_and_partial_answers():
    flat, _ = _flatten_nested_basemodels(_RootWithOptionalNested)

    assert flat.model_validate({})
    assert flat.model_validate({"q5__doenca": "parcial"})

    flat_with_required_subfield, _ = _flatten_nested_basemodels(
        _RootWithOptionalNestedAndRequiredSubfield
    )
    assert flat_with_required_subfield.model_validate({"details__note": "parcial"})


def test_sentinel_cannot_be_combined_with_content_in_active_group():
    flat, _ = _flatten_nested_basemodels(_RequiredAtLeastOne)

    with pytest.raises(ValidationError, match="não pode combinar"):
        flat.model_validate(
            {
                "details": _NOT_INFORMED_SENTINEL,
                "details__other": "valor",
            }
        )


class _ConditionalRoot(BaseModel):
    trigger: Literal["sim", "nao"]
    details: _AtLeastOneSubfields = Field(
        json_schema_extra={
            "subfield_rule": "at_least_one",
            "condition": {"field": "trigger", "equals": "sim"},
        }
    )


def test_inactive_condition_skips_entire_group_validation():
    flat, _ = _flatten_nested_basemodels(_ConditionalRoot)

    assert flat.model_validate({"trigger": "nao"})
    assert flat.model_validate(
        {
            "trigger": "nao",
            "details": _NOT_INFORMED_SENTINEL,
            "details__other": "ignorado no prune",
        }
    )
    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        flat.model_validate({"trigger": "sim"})


def test_justifications_skip_synthetic_sentinel_and_inherit_validator():
    flat, _ = _flatten_nested_basemodels(_RequiredAtLeastOne)
    extended = _extend_model_with_justifications(flat)

    assert "details_justification" not in extended.model_fields
    assert "details__other_justification" in extended.model_fields
    assert "details" not in _generated_justification_fields(extended)
    with pytest.raises(ValidationError, match="ao menos um subcampo"):
        extended.model_validate(
            {
                "details__dormant_required_justification": "ausente",
                "details__other_justification": "ausente",
            }
        )


def test_expected_coverage_ignores_synthetic_sentinel_and_collapses_subfields():
    flat, specs = _flatten_nested_basemodels(_RootWithNested)
    extended = _extend_model_with_justifications(flat)

    assert _expected_llm_fields(extended, specs) == {"q2", "q5"}

    optional_flat, optional_specs = _flatten_nested_basemodels(_RootWithOptionalNested)
    assert _expected_llm_fields(optional_flat, optional_specs) == set()


def test_reconstruction_builds_nested_dict_and_joins_justifications():
    _, specs = _flatten_nested_basemodels(_RootWithNested)
    answers = {"q2": "12345", "q5__doenca": "AME tipo 1", "q5__cid": "G12.0"}
    justifications = {
        "q5__doenca": "Mencionado no parágrafo 2",
        "q5__cid": "CID-10 citado",
    }

    _reconstruct_nested_answers(answers, justifications, specs)

    assert answers == {
        "q2": "12345",
        "q5": {"doenca": "AME tipo 1", "cid": "G12.0"},
    }
    assert justifications == {
        "q5": "doenca: Mencionado no parágrafo 2\ncid: CID-10 citado",
    }


def test_reconstruction_persists_sentinel_instead_of_empty_dict():
    _, specs = _flatten_nested_basemodels(_RootWithNested)
    answers = {"q2": "12345", "q5": _NOT_INFORMED_SENTINEL}
    justifications: dict = {}

    _reconstruct_nested_answers(answers, justifications, specs)

    assert answers == {"q2": "12345", "q5": _NOT_INFORMED_SENTINEL}
    assert justifications == {}


def test_reconstruction_omits_nested_when_all_subfields_missing():
    _, specs = _flatten_nested_basemodels(_RootWithOptionalNested)
    answers: dict = {}
    justifications: dict = {}

    _reconstruct_nested_answers(answers, justifications, specs)

    assert answers == {}
    assert justifications == {}
