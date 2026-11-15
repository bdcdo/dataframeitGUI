"""Round-trip do schema como propriedade (#525), lado do compilador.

Prende a saída de `compile_pydantic` para os casos gravados; o contrato e o
comando de regeneração estão em `schema-roundtrip.property.test.ts`.
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
