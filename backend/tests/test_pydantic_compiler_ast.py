"""Testes do allowlist AST do compilador (vuln-0001 / #163).

Garante que nenhum payload malicioso executa código (sem side-effect) e que a
classe reconstruída via create_model é um BaseModel funcional — o que o
llm_runner precisa para validar a saída do LLM.
"""

import os

import pytest
from pydantic import BaseModel, ValidationError

from services.pydantic_compiler import build_model_from_code, compile_pydantic

VALID = """from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    topic: Literal["a", "b"] = Field(description="Topic")
    tags: list[Literal["x", "y"]] = Field(description="Tags")
    note: Optional[str] = Field(default=None, description="Note")
"""


# ----------------------- payloads maliciosos -----------------------

MALICIOUS = [
    "import os",
    "from os import system",
    'import os\nos.system("id")',
    "import subprocess",
    "import socket",
    'x = open("/etc/passwd").read()',
    '__import__("os").system("id")',
    """from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default=eval("1+1"))""",
    """from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default=__import__("os"))""",
    """from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(default_factory=lambda: 1)""",
    """from pydantic import BaseModel, Field
class A(BaseModel):
    x: str = Field(description=().__class__.__name__)""",
    "y = [i for i in range(3)]",
    """@staticmethod
class A(BaseModel):
    pass""",
    """from pydantic import BaseModel
class A(BaseModel):
    def __init__(self):
        __import__("os").system("id")""",
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
    code = f"import pathlib\npathlib.Path({str(marker)!r}).write_text('owned')\n"
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
    code = """from pydantic import BaseModel, Field
from typing import Optional

class _doc_fields(BaseModel):
    part_a: str = Field(description="A")
    part_b: Optional[str] = Field(default=None, description="B")

class Analysis(BaseModel):
    doc: _doc_fields = Field(description="Doc")
"""
    model = build_model_from_code(code)
    inst = model(doc={"part_a": "x"})
    assert inst.doc.part_a == "x"
    assert inst.doc.part_b is None


def test_union_pipe_syntax_rejected():
    # Após o estreitamento à grammar do gerador, `X | None` não é suportado (o
    # gerador usa Optional[...]). Deve ser rejeitado de forma limpa, não aceito.
    code = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    x: str | None = Field(default=None, description="X")
"""
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_top_level_literal_assignment_allowed_but_no_model():
    # `x = 1` é inofensivo; sem BaseModel o resultado é erro de "sem modelo".
    result = compile_pydantic("x = 1\n")
    assert result["valid"] is False
    assert "BaseModel" in result["errors"][0]


def test_no_side_effect_global_sentinel():
    # Reforço: nenhum dos payloads tocou o processo.
    assert not os.environ.get("PWNED")


# ----------------------- nomes e dunders (item #197 review) -----------------


def test_field_name_with_internal_double_underscore_accepted():
    # Nome legítimo com "__" interno não pode ser barrado pela guarda de
    # dunder — só dunders estritos (começam E terminam com "__") são perigosos.
    code = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    my__field: str = Field(description="X")
"""
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    assert result["fields"][0]["name"] == "my__field"


def test_nested_class_name_with_boundary_underscore_accepted():
    # O gerador nomeia a classe aninhada `_<campo>_fields`; um campo terminando
    # em "_" produz `_doc__fields` (com "__" interno), que deve compilar.
    code = """from pydantic import BaseModel, Field

class _doc__fields(BaseModel):
    part_a: str = Field(description="A")

class Analysis(BaseModel):
    doc_: _doc__fields = Field(description="Doc")
"""
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]


def test_strict_dunder_field_name_rejected():
    # Dunder estrito continua barrado (defense-in-depth).
    code = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    __class__: str = Field(description="X")
"""
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_deeply_nested_annotation_rejected_with_message():
    # Aninhamento patológico vira SchemaError claro, não RecursionError.
    ann = "list[" * 25 + "int" + "]" * 25
    code = (
        "from pydantic import BaseModel, Field\n"
        "class Analysis(BaseModel):\n"
        f'    x: {ann} = Field(description="X")\n'
    )
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert any("aninhada" in e for e in result["errors"])


# ------------- estreitamento à grammar do gerador (hardening #197) -----------


@pytest.mark.parametrize(
    "annotation",
    [
        'Annotated[str, Field(description="d")]',  # forma canônica do Annotated
        "Annotated[str]",  # Annotated de 1 elemento (antes: TypeError cru)
        "dict[str, str]",
        "dict[str]",  # antes: ValueError cru de unpack
        "tuple[str, int]",
        "Union[str, int]",
    ],
)
def test_unsupported_type_constructors_rejected_cleanly(annotation):
    # Construtores que o gerador nunca emite são rejeitados com SchemaError
    # (nunca ValueError/TypeError cru) — build_model_from_code honra o contrato.
    code = (
        "from pydantic import BaseModel, Field\n"
        "from typing import Annotated, Union\n"
        "class Analysis(BaseModel):\n"
        f'    x: {annotation} = Field(description="X")\n'
    )
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_build_raises_only_schema_error_on_bad_constructor():
    # Contrato: build_model_from_code levanta SchemaError, não ValueError/TypeError.
    from services.pydantic_compiler import SchemaError

    code = (
        "from pydantic import BaseModel, Field\n"
        "class Analysis(BaseModel):\n"
        '    x: dict[str] = Field(description="X")\n'
    )
    with pytest.raises(SchemaError):
        build_model_from_code(code)


def test_multiple_inheritance_rejected_not_silently_collapsed():
    # Antes: herança múltipla colapsava para a última base, descartando campos
    # do mixin em silêncio. Agora é rejeitada explicitamente.
    code = """from pydantic import BaseModel, Field

class Mixin(BaseModel):
    m: str = Field(description="m")

class Analysis(Mixin, BaseModel):
    x: str = Field(description="x")
"""
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_strict_dunder_class_name_rejected():
    # Nome de classe dunder (ast.ClassDef.name, não ast.Name) é barrado.
    code = """from pydantic import BaseModel, Field

class __reduce__(BaseModel):
    x: int = Field(default=1)

class Analysis(BaseModel):
    x: int = Field(default=1)
"""
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_strict_dunder_field_kwarg_rejected():
    # Nome de kwarg de Field dunder (kw.arg é str, não ast.Name) é barrado.
    code = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    x: int = Field(__class__=1, default=1)
"""
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


@pytest.mark.parametrize("name", ["__", "___", "____"])
def test_all_underscore_field_names_rejected(name):
    # `__`/`___`/`____` começam E terminam com "__" → dunder estrito, rejeitado.
    # (Alinhado ao isStrictDunder do frontend, que antes divergia para __/___.)
    code = (
        "from pydantic import BaseModel, Field\n"
        "class Analysis(BaseModel):\n"
        f'    {name}: str = Field(description="X")\n'
    )
    result = compile_pydantic(code)
    assert result["valid"] is False
    assert result["errors"]


def test_oversized_code_rejected():
    from services.pydantic_compiler import _MAX_CODE_LENGTH, SchemaError

    code = "x = 1\n" * (_MAX_CODE_LENGTH // 2)
    assert len(code) > _MAX_CODE_LENGTH
    with pytest.raises(SchemaError):
        build_model_from_code(code)


def test_type_depth_boundary():
    # Fixa a fronteira de _MAX_TYPE_DEPTH: até o limite compila; acima rejeita.
    from services.pydantic_compiler import _MAX_TYPE_DEPTH

    def code_for(depth):
        ann = "list[" * depth + "str" + "]" * depth
        return (
            "from pydantic import BaseModel, Field\n"
            "class Analysis(BaseModel):\n"
            f'    x: {ann} = Field(description="X")\n'
        )

    # Profundidade no limite é aceita (str na base conta como nível extra,
    # então usamos _MAX_TYPE_DEPTH wrappers de list).
    ok = compile_pydantic(code_for(_MAX_TYPE_DEPTH - 1))
    assert ok["valid"], ok["errors"]
    too_deep = compile_pydantic(code_for(_MAX_TYPE_DEPTH + 5))
    assert too_deep["valid"] is False
    assert any("aninhada" in e for e in too_deep["errors"])
