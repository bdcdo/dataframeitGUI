"""Round-trip do schema como propriedade (#525), lado do compilador.

`schema_roundtrip_cases.json` traz schemas sorteados pelo fast-check, o código
que o `generatePydanticCode` real emite para eles e os campos que este
compilador devolveu desse código. O teste do frontend
(`schema-roundtrip.property.test.ts`) prova que esses campos são o schema
original pela normalização canônica do app (`snapshotOf`); este prende o
compilador: uma propriedade que ele deixe de ler muda a saída e reprova aqui.

Mudança intencional no compilador pede regenerar o arquivo (comando no teste do
frontend), e a regeneração passa de novo pela equivalência de lá.
"""

import json
from pathlib import Path

import pytest

from services.pydantic_compiler import compile_pydantic

# O gerador de casos sorteia de propósito nomes como `json` e `copy`, que a GUI
# aceita e o Pydantic compila com aviso de que sombreiam atributo do BaseModel.
pytestmark = pytest.mark.filterwarnings(
    "ignore:Field name .* shadows an attribute:UserWarning"
)

_CASES = json.loads(
    (Path(__file__).parent / "schema_roundtrip_cases.json").read_text(encoding="utf-8")
)


def test_cases_exist():
    assert len(_CASES) >= 50


@pytest.mark.parametrize("case", _CASES, ids=lambda case: f"caso-{case['case']}")
def test_compile_returns_recorded_fields(case):
    result = compile_pydantic(case["code"])
    assert result["valid"], result["errors"]
    assert result["model_name"] == "Analysis"
    assert result["fields"] == case["compiled"]
