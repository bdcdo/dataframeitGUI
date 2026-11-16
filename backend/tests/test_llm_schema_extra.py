"""O modelo que vai ao provider não carrega as chaves internas do schema (#697).

`json_schema_extra` entra inline em cada propriedade do JSON Schema que o
provider recebe. As chaves que o gerador grava ali são metadado de produto;
`_prepare_llm_model` as tira na última etapa, depois de ler o que precisa.
"""

import json

import pytest
from pydantic import BaseModel, Field

from services.llm_runner import (
    _DATAFRAMEIT_EXTRA_KEYS,
    _expected_llm_fields,
    _prepare_llm_model,
    _strip_internal_schema_extra,
)

# Como `generatePydanticCode` emite: todas as chaves internas que o gerador
# conhece, um composto condicional (achatado para o LLM) e um prompt de
# justificativa do coordenador.
GENERATED_CODE = """from pydantic import BaseModel, Field
from typing import Literal, Optional


class _doc_fields(BaseModel):
    part_a: str = Field(description="Parte A", json_schema_extra={"subfield_required": True})
    part_b: Optional[str] = Field(default=None, description="Parte B")


class Analysis(BaseModel):
    has_doc: Literal["Sim", "Não"] = Field(description="Tem documento?. Instrucoes: Olhe a capa", json_schema_extra={"id": "11111111-1111-4111-8111-111111111111", "options": ["Sim", "Não"], "allowOther": True, "help_text": "Olhe a capa", "justification_prompt": "Cite o trecho de {name}."})
    quando: Optional[str] = Field(default=None, description="Quando?", json_schema_extra={"id": "22222222-2222-4222-8222-222222222222", "field_type": "date", "target": "llm_only", "required": False, "visible_if": {"field": "has_doc", "equals": "Sim"}})
    doc: Optional[_doc_fields] = Field(default=None, description="Doc", json_schema_extra={"id": "33333333-3333-4333-8333-333333333333", "visible_if": {"field": "has_doc", "equals": "Sim"}})
"""

STANDARD_PROPERTY_KEYS = {
    "anyOf",
    "default",
    "description",
    "enum",
    "title",
    "type",
}


def _assert_only_standard_keys(properties: dict) -> None:
    for name, prop in properties.items():
        assert set(prop) <= STANDARD_PROPERTY_KEYS, name


@pytest.mark.parametrize("include_justifications", [False, True])
def test_schema_enviado_ao_provider_so_tem_chaves_de_json_schema(
    include_justifications,
):
    prepared = _prepare_llm_model(GENERATED_CODE, [], include_justifications)

    schema = prepared.model_class.model_json_schema()

    assert "$defs" not in schema
    _assert_only_standard_keys(schema["properties"])
    serialized = json.dumps(schema, ensure_ascii=False)
    # `help_text` segue na descrição, onde o gerador o põe de propósito; o
    # que sai é a segunda cópia, a de `json_schema_extra`.
    assert serialized.count("Olhe a capa") == 1
    assert "visible_if" not in serialized
    # O contrato de saída continua inteiro.
    assert schema["properties"]["has_doc"]["enum"] == ["Sim", "Não"]
    assert schema["properties"]["has_doc"]["description"] == (
        "Tem documento?. Instrucoes: Olhe a capa"
    )


def test_o_que_o_runner_le_do_extra_e_lido_antes_do_filtro():
    prepared = _prepare_llm_model(GENERATED_CODE, [], True)
    model = prepared.model_class

    # `justification_prompt` virou a descrição do campo gerado...
    assert (
        model.model_fields["has_doc_justification"].description
        == "Cite o trecho de has_doc."
    )
    # ...as condições de visibilidade foram extraídas...
    assert set(prepared.field_conditions) == {"quando", "doc"}
    # ...e o registro das justificativas geradas sobrevive à reconstrução.
    assert "has_doc" in _expected_llm_fields(model)
    assert "has_doc_justification" not in _expected_llm_fields(model)
    assert prepared.nested_field_map == {
        "doc": [("doc__part_a", "part_a"), ("doc__part_b", "part_b")]
    }
    # A reconstrução não mexe em nome, ordem nem obrigatoriedade.
    assert model.__name__ == "AnalysisFlatWithJustifications"
    assert list(model.model_fields)[:2] == ["has_doc", "quando"]
    assert model.model_fields["has_doc"].is_required()
    assert not model.model_fields["quando"].is_required()


def test_chaves_da_biblioteca_ficam_no_modelo():
    """A configuração de busca por campo é do dataframeit: ele a lê e a tira."""

    class Handwritten(BaseModel):
        campo: str = Field(
            description="Campo",
            json_schema_extra={
                "id": "x",
                "prompt": "Busque {query}",
                "search_depth": "advanced",
            },
        )

    stripped = _strip_internal_schema_extra(Handwritten)

    assert stripped.model_fields["campo"].json_schema_extra == {
        "prompt": "Busque {query}",
        "search_depth": "advanced",
    }


def test_submodelo_dentro_de_lista_tambem_e_limpo():
    """O achatamento não alcança `list[BaseModel]`, que iria inteiro em `$defs`."""
    code = """from pydantic import BaseModel, Field
from typing import Optional


class Item(BaseModel):
    nome: str = Field(description="Nome", json_schema_extra={"id": "a", "help_text": "h"})


class Analysis(BaseModel):
    itens: Optional[list[Item]] = Field(default=None, description="Itens")
"""
    model = _prepare_llm_model(code, [], False).model_class

    schema = model.model_json_schema()

    _assert_only_standard_keys(schema["$defs"]["Item"]["properties"])
    parsed = model.model_validate({"itens": [{"nome": "x"}]})
    assert parsed.model_dump() == {"itens": [{"nome": "x"}]}


def test_modelo_sem_chave_interna_volta_o_mesmo_objeto():
    class Plain(BaseModel):
        a: str = Field(description="A")
        b: str = Field(description="B", json_schema_extra={"prompt": "p"})

    assert _strip_internal_schema_extra(Plain) is Plain


def test_chaves_da_biblioteca_acompanham_o_dataframeit_instalado():
    from dataframeit.agent import _LIBRARY_EXTRA_KEYS

    assert _DATAFRAMEIT_EXTRA_KEYS == _LIBRARY_EXTRA_KEYS


def test_dataframeit_real_entrega_ao_cliente_o_schema_sem_chaves_internas(monkeypatch):
    """Atravessa o pacote instalado até `with_structured_output`, sem rede."""
    import pandas as pd
    from dataframeit import dataframeit
    from langchain import chat_models

    schemas = []

    class FakeChat:
        def with_structured_output(self, model, *, include_raw):
            schemas.append(model.model_json_schema())

            class FakeStructuredChat:
                def invoke(self, _messages):
                    values = {
                        "has_doc": "Sim",
                        "has_doc_justification": "j",
                        "quando_justification": "j",
                        "doc__part_a_justification": "j",
                        "doc__part_b_justification": "j",
                    }
                    return {"parsed": model.model_validate(values), "raw": None}

            return FakeStructuredChat()

    monkeypatch.setattr(chat_models, "init_chat_model", lambda *_a, **_k: FakeChat())
    prepared = _prepare_llm_model(GENERATED_CODE, [], True)

    result = dataframeit(
        pd.DataFrame([{"id": "1", "texto": "documento"}]),
        prepared.model_class,
        "{texto}",
        model="fake",
        provider="openai",
        resume=False,
    )

    assert result["has_doc"].tolist() == ["Sim"]
    assert schemas
    for schema in schemas:
        _assert_only_standard_keys(schema["properties"])
