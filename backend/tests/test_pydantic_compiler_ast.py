"""Testes do allowlist AST do compilador (vuln-0001 / #163).

Garante que nenhum payload malicioso executa código (sem side-effect) e que a
classe reconstruída via create_model é um BaseModel funcional — o que o
llm_runner precisa para validar a saída do LLM.
"""
import os

import pytest
from pydantic import BaseModel, ValidationError

from services.pydantic_compiler import build_model_from_code, compile_pydantic

VALID = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    topic: Literal["a", "b"] = Field(description="Topic")
    tags: list[Literal["x", "y"]] = Field(description="Tags")
    note: Optional[str] = Field(default=None, description="Note")
'''


# ----------------------- payloads maliciosos -----------------------

MALICIOUS = [
    "import os",
    "from os import system",
    'import os\nos.system("id")',
    "import subprocess",
    "import socket",
    'x = open("/etc/passwd").read()',
    '__import__("os").system("id")',
    '''from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default=eval("1+1"))''',
    '''from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default=__import__("os"))''',
    '''from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default_factory=lambda: 1)''',
    '''from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(description=().__class__.__name__)''',
    "y = [i for i in range(3)]",
    '''@staticmethod
class A(BaseModel):
    pass''',
    '''from pydantic import BaseModel
class A(BaseModel):
    def __init__(self):
        __import__("os").system("id")''',
]


@pytest.mark.parametrize("code", MALICIOUS, ids=range(len(MALICIOUS)))
def test_malicious_payload_rejected(code):
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]
    assert result["fields"] == []


def test_strix_poc_does_not_write_file(tmp_path):
    """O PoC do strix escrevia um arquivo via pathlib; aqui ele nem importa."""
    marker = tmp_path / "PWNED"
    code = (
        "import pathlib\n"
        f"pathlib.Path({str(marker)!r}).write_text('owned')\n"
    )
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert not marker.exists()


def test_field_default_call_rejected(tmp_path):
    marker = tmp_path / "PWNED2"
    code = (
        "from pydantic import BaseModel, Field\n"
        "class Analysis(BaseModel):\n"
        f"    x: str = Field(default=open({str(marker)!r}, 'w'))\n"
    )
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert not marker.exists()


# ----------------------- construção funcional -----------------------


def test_build_returns_functional_model():
    model = build_model_from_code(VALID)
    assert isinstance(model, type) and issubclass(model, BaseModel)
    inst = model(topic="a", tags=["x"], note=None)
    assert inst.topic == "a"
    assert inst.tags == ["x"]


def test_built_model_enforces_literal():
    model = build_model_from_code(VALID)
    with pytest.raises(ValidationError):
        model(topic="invalid", tags=[])


def test_built_nested_model_roundtrips():
    code = '''from pydantic import BaseModel, Field
from typing import Optional

class _doc_fields(BaseModel):
    part_a: str = Field(description="A")
    part_b: Optional[str] = Field(default=None, description="B")

class Analysis(BaseModel):
    doc: _doc_fields = Field(description="Doc")
'''
    model = build_model_from_code(code)
    inst = model(doc={"part_a": "x"})
    assert inst.doc.part_a == "x"
    assert inst.doc.part_b is None


def test_union_pipe_syntax_supported():
    # Edição manual pode usar `str | None` em vez de Optional[str].
    code = '''from pydantic import BaseModel, Field

class Analysis(BaseModel):
    x: str | None = Field(default=None, description="X")
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    assert result["fields"][0]["name"] == "x"


def test_top_level_literal_assignment_allowed_but_no_model():
    # `x = 1` é inofensivo; sem BaseModel o resultado é erro de "sem modelo".
    result = compile_pydantic("x = 1\n")
    assert result["valid"] is False
    assert "BaseModel" in result["errors"][0]


def test_no_side_effect_global_sentinel():
    # Reforço: nenhum dos payloads tocou o processo.
    assert not os.environ.get("PWNED")
