"""Nomes de campo que o código gerado não compila — paridade com a GUI (#525).

`reserved_field_names.json` é a cópia das listas de `pydanticFieldNameIssue`
(frontend/src/lib/pydantic-field.ts), que o Vitest confere contra o TS. Aqui o
arquivo é conferido contra o `compile_pydantic` real nos dois sentidos: todo
nome listado é recusado, como campo e como subcampo, e todo outro candidato
plausível compila. Uma versão nova do Python ou do Pydantic que reserve mais um
nome reprova no segundo teste, antes de a GUI deixar salvar um schema que não
compila.
"""

import json
import keyword
import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from services.pydantic_compiler import compile_pydantic

_RESERVED = json.loads(
    (Path(__file__).parent / "reserved_field_names.json").read_text(encoding="utf-8")
)
_REFUSED = (
    _RESERVED["python_keywords"]
    + _RESERVED["pydantic_reserved"]
    + _RESERVED["private_examples"]
)
# Mesmo regex de PYTHON_IDENTIFIER no frontend, sem o `_` inicial, que a GUI
# recusa por regra e não por lista.
_PUBLIC_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")
_ID = "00000000-0000-4000-8000-000000000525"


def _field_code(name: str) -> str:
    return (
        "from pydantic import BaseModel, Field\n"
        "from typing import Literal, Optional\n\n"
        "class Analysis(BaseModel):\n"
        f'    {name}: str = Field(description="d", '
        f'json_schema_extra={{"id": "{_ID}"}})\n'
    )


def _subfield_code(key: str) -> str:
    return (
        "from pydantic import BaseModel, Field\n"
        "from typing import Literal, Optional\n\n\n"
        "class _doc_fields(BaseModel):\n"
        f'    {key}: str = Field(description="l")\n\n'
        "class Analysis(BaseModel):\n"
        f'    doc: _doc_fields = Field(description="d", '
        f'json_schema_extra={{"id": "{_ID}"}})\n'
    )


def _compiles(name: str) -> tuple[bool, bool]:
    return (
        compile_pydantic(_field_code(name))["valid"],
        compile_pydantic(_subfield_code(name))["valid"],
    )


@pytest.mark.parametrize("name", _REFUSED)
def test_reserved_name_does_not_compile(name):
    assert _compiles(name) == (False, False)


# Candidatos: palavras-chave (inclusive as leves, `match`/`case`/`type`) e todo
# atributo do BaseModel, que é onde o Pydantic reserva nomes.
_CANDIDATES = sorted(
    {
        name
        for name in [*keyword.kwlist, *keyword.softkwlist, *dir(BaseModel)]
        if _PUBLIC_IDENTIFIER.match(name)
    }
)


@pytest.mark.filterwarnings("ignore:Field name .* shadows an attribute")
def test_every_other_candidate_compiles():
    listed = set(_REFUSED)
    refused = [
        name
        for name in _CANDIDATES
        if name not in listed and _compiles(name) != (True, True)
    ]
    assert refused == [], (
        "o backend recusa nomes que a GUI deixa salvar; inclua-os em "
        "PYTHON_KEYWORDS/PYDANTIC_RESERVED_NAMES e em reserved_field_names.json"
    )
