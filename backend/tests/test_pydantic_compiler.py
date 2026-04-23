"""Round-trip and robustness tests for services.pydantic_compiler."""
from pydantic import BaseModel, Field

from services.pydantic_compiler import compile_pydantic, find_root_model


def _field(result: dict, name: str) -> dict:
    for f in result["fields"]:
        if f["name"] == name:
            return f
    raise AssertionError(
        f"field {name!r} not found in {[f['name'] for f in result['fields']]}"
    )


def test_single_literal_field_round_trip():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    topic: Literal["a", "b"] = Field(description="Topic of the decision")
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    f = _field(result, "topic")
    assert f["type"] == "single"
    assert f["options"] == ["a", "b"]
    assert f["description"] == "Topic of the decision"
    assert f["target"] == "all"
    assert "help_text" not in f


def test_multi_literal_field_round_trip():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    tags: list[Literal["x", "y", "z"]] = Field(description="Tags")
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    f = _field(result, "tags")
    assert f["type"] == "multi"
    assert f["options"] == ["x", "y", "z"]


def test_help_text_is_stripped_from_description():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    verdict: Literal["yes", "no"] = Field(
        description="Outcome. Instrucoes: Considere apenas o dispositivo",
        json_schema_extra={"help_text": "Considere apenas o dispositivo"},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "verdict")
    assert f["description"] == "Outcome"
    assert f["help_text"] == "Considere apenas o dispositivo"


def test_help_text_whitespace_is_ignored():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    verdict: Literal["yes", "no"] = Field(
        description="Outcome",
        json_schema_extra={"help_text": "   "},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "verdict")
    assert f["description"] == "Outcome"
    assert "help_text" not in f


def test_subfield_rule_defaults_to_all():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class _doc_fields(BaseModel):
    part_a: str = Field(description="Part A")
    part_b: Optional[str] = Field(default=None, description="Part B")

class Analysis(BaseModel):
    doc: _doc_fields = Field(description="Document breakdown")
'''
    result = compile_pydantic(code)
    f = _field(result, "doc")
    assert f["type"] == "text"
    assert f["subfields"] == [
        {"key": "part_a", "label": "Part A", "required": True},
        {"key": "part_b", "label": "Part B", "required": False},
    ]
    assert f["subfield_rule"] == "all"


def test_subfield_rule_at_least_one_preserved():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class _doc_fields(BaseModel):
    part_a: Optional[str] = Field(default=None, description="Part A")
    part_b: Optional[str] = Field(default=None, description="Part B")

class Analysis(BaseModel):
    doc: _doc_fields = Field(
        description="Doc",
        json_schema_extra={"subfield_rule": "at_least_one"},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "doc")
    assert f["subfield_rule"] == "at_least_one"


def test_allow_other_preserved_for_single():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    court: Literal["STF", "STJ"] = Field(
        description="Court",
        json_schema_extra={"allowOther": True},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "court")
    assert f.get("allow_other") is True


def test_date_field_type_override():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    judged_on: str = Field(
        description="Judgment date. Formato: DD/MM/AAAA (use XX para partes desconhecidas)",
        json_schema_extra={"field_type": "date"},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "judged_on")
    assert f["type"] == "date"


def test_target_preserved():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    headline: str = Field(
        description="Ementa",
        json_schema_extra={"target": "ementa"},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "headline")
    assert f["target"] == "ementa"


def test_field_hash_stable_across_whitespace_help_text_and_none():
    """Hash should stay the same whether help_text is absent or empty/whitespace,
    because in both cases the effective description is identical."""
    plain = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    x: Literal["a"] = Field(description="Pure description")
'''
    whitespace = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    x: Literal["a"] = Field(
        description="Pure description",
        json_schema_extra={"help_text": "   "},
    )
'''
    h1 = _field(compile_pydantic(plain), "x")["hash"]
    h2 = _field(compile_pydantic(whitespace), "x")["hash"]
    assert h1 == h2


def test_field_hash_matches_description_without_suffix():
    """When help_text is emitted structurally, description returned is pure,
    and hash is computed over the pure description (not the ". Instrucoes: ..." form)."""
    with_help = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    x: Literal["a"] = Field(
        description="Pure. Instrucoes: extra",
        json_schema_extra={"help_text": "extra"},
    )
'''
    without_help = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    x: Literal["a"] = Field(description="Pure")
'''
    h1 = _field(compile_pydantic(with_help), "x")["hash"]
    h2 = _field(compile_pydantic(without_help), "x")["hash"]
    assert h1 == h2


def test_find_root_model_prefers_analysis_class():
    class Analysis(BaseModel):
        pass

    class Helper(BaseModel):
        pass

    ns = {"Analysis": Analysis, "Helper": Helper}
    root = find_root_model(ns)
    assert root is Analysis


def test_find_root_model_picks_root_by_graph():
    """No class named Analysis — the root is the one referencing others."""

    class Leaf(BaseModel):
        pass

    class Root(BaseModel):
        child: Leaf = Field(description="x")

    ns = {"Leaf": Leaf, "Root": Root}
    root = find_root_model(ns)
    assert root is Root


def test_find_root_model_falls_back_to_last_when_ambiguous():
    """Two independent models — falls back to last-defined."""

    class A(BaseModel):
        pass

    class B(BaseModel):
        pass

    ns = {"A": A, "B": B}
    root = find_root_model(ns)
    assert root is B


def test_find_root_model_analysis_wins_even_when_helpers_defined_after():
    """Manually edited code: Analysis first, helpers after. Old "last" heuristic
    would pick the helper; new logic picks Analysis."""

    class Analysis(BaseModel):
        pass

    class HelperA(BaseModel):
        pass

    class HelperB(BaseModel):
        pass

    ns = {"Analysis": Analysis, "HelperA": HelperA, "HelperB": HelperB}
    root = find_root_model(ns)
    assert root is Analysis


def test_empty_namespace_returns_none():
    assert find_root_model({}) is None


def test_invalid_code_returns_error():
    result = compile_pydantic("this is not python {{{")
    assert result["valid"] is False
    assert result["errors"]
    assert result["fields"] == []


def test_no_basemodel_returns_error():
    result = compile_pydantic("x = 1\n")
    assert result["valid"] is False
    assert "BaseModel" in result["errors"][0]


def test_condition_equals_round_trips():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    houve_provimento: Literal["sim", "nao"] = Field(description="Houve provimento?")
    provimento_parcial: Optional[Literal["sim", "nao"]] = Field(
        description="Provimento foi parcial?",
        json_schema_extra={"condition": {"field": "houve_provimento", "equals": "sim"}},
    )
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    f = _field(result, "provimento_parcial")
    assert f["condition"] == {"field": "houve_provimento", "equals": "sim"}


def test_condition_in_list_round_trips():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    tipo: Literal["a", "b", "c"] = Field(description="Tipo")
    follow: Optional[str] = Field(
        description="Follow-up",
        json_schema_extra={"condition": {"field": "tipo", "in": ["a", "b"]}},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "follow")
    assert f["condition"] == {"field": "tipo", "in": ["a", "b"]}


def test_condition_exists_round_trips():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    note: Optional[str] = Field(description="note")
    extra: Optional[str] = Field(
        description="extra",
        json_schema_extra={"condition": {"field": "note", "exists": True}},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "extra")
    assert f["condition"] == {"field": "note", "exists": True}


def test_condition_hash_exclusion():
    """Adding or changing a condition must not change the field hash —
    it would invalidate existing responses whose value is still valid."""
    without = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    x: Literal["a"] = Field(description="desc")
'''
    with_cond = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    x: Optional[Literal["a"]] = Field(
        description="desc",
        json_schema_extra={"condition": {"field": "other", "equals": "a"}},
    )
'''
    h1 = _field(compile_pydantic(without), "x")["hash"]
    h2 = _field(compile_pydantic(with_cond), "x")["hash"]
    assert h1 == h2


def test_malformed_condition_is_dropped():
    code = '''from pydantic import BaseModel, Field
from typing import Literal, Optional

class Analysis(BaseModel):
    x: Optional[Literal["a"]] = Field(
        description="desc",
        json_schema_extra={"condition": {"wrong": "shape"}},
    )
'''
    result = compile_pydantic(code)
    f = _field(result, "x")
    assert "condition" not in f


def test_multiline_help_text_round_trips():
    """compile_pydantic must strip a multi-line suffix correctly when
    help_text contains newlines."""
    code = (
        "from pydantic import BaseModel, Field\n"
        "from typing import Literal\n\n"
        "class Analysis(BaseModel):\n"
        '    x: Literal["a"] = Field(\n'
        '        description="linha1\\nlinha2. Instrucoes: ins1\\nins2",\n'
        '        json_schema_extra={"help_text": "ins1\\nins2"},\n'
        "    )\n"
    )
    result = compile_pydantic(code)
    f = _field(result, "x")
    assert f["description"] == "linha1\nlinha2"
    assert f["help_text"] == "ins1\nins2"


def test_target_none_round_trips():
    """target="none" is preserved by the compiler (used to hide fields from
    both humans and LLM while keeping them in pydantic_code as source of
    truth)."""
    code = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    hidden_field: Literal["a", "b"] = Field(
        description="Hidden",
        json_schema_extra={"target": "none"},
    )
    visible: Literal["x"] = Field(description="Visible")
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    hidden = _field(result, "hidden_field")
    assert hidden["target"] == "none"
    visible = _field(result, "visible")
    assert visible["target"] == "all"


def test_date_field_with_sentinel_options_round_trips():
    """Date fields carry sentinel options (ex: 'Não identificável') via
    json_schema_extra because the annotation itself is `str`, not Literal."""
    code = '''from pydantic import BaseModel, Field
from typing import Literal

class Analysis(BaseModel):
    birth_date: str = Field(
        description="Data de nascimento",
        json_schema_extra={
            "field_type": "date",
            "options": ["Não identificável"],
        },
    )
'''
    result = compile_pydantic(code)
    assert result["valid"], result["errors"]
    f = _field(result, "birth_date")
    assert f["type"] == "date"
    assert f["options"] == ["Não identificável"]


def test_date_description_strips_generated_suffixes():
    """generatePydanticCode appends ". Formato: DD/MM/AAAA..." and, when
    options exist, ". Caso não seja possível informar a data, usar um dos
    seguintes valores: ..." to the description. The compiler must strip
    both suffixes so the description round-trips cleanly (otherwise each
    UI -> compile -> UI cycle accumulates the suffix)."""
    # Date without options: only the format suffix
    code_no_opts = '''from pydantic import BaseModel, Field

class Analysis(BaseModel):
    d: str = Field(
        description="Data da decisão. Formato: DD/MM/AAAA (use XX para partes desconhecidas)",
        json_schema_extra={"field_type": "date"},
    )
'''
    result = compile_pydantic(code_no_opts)
    assert result["valid"], result["errors"]
    f = _field(result, "d")
    assert f["description"] == "Data da decisão"
    assert f["type"] == "date"

    # Date with options: both suffixes, stripped in reverse order
    code_with_opts = '''from pydantic import BaseModel, Field

class Analysis(BaseModel):
    d: str = Field(
        description='Data da decisão. Formato: DD/MM/AAAA (use XX para partes desconhecidas). Caso não seja possível informar a data, usar um dos seguintes valores: "Não identificável", "Não aplicável"',
        json_schema_extra={
            "field_type": "date",
            "options": ["Não identificável", "Não aplicável"],
        },
    )
'''
    result = compile_pydantic(code_with_opts)
    assert result["valid"], result["errors"]
    f = _field(result, "d")
    assert f["description"] == "Data da decisão"
    assert f["options"] == ["Não identificável", "Não aplicável"]

    # Date with options AND help_text: all three suffixes combined
    code_full = '''from pydantic import BaseModel, Field

class Analysis(BaseModel):
    d: str = Field(
        description='Data da decisão. Formato: DD/MM/AAAA (use XX para partes desconhecidas). Caso não seja possível informar a data, usar um dos seguintes valores: "Não identificável". Instrucoes: Use a data da publicação',
        json_schema_extra={
            "field_type": "date",
            "options": ["Não identificável"],
            "help_text": "Use a data da publicação",
        },
    )
'''
    result = compile_pydantic(code_full)
    assert result["valid"], result["errors"]
    f = _field(result, "d")
    assert f["description"] == "Data da decisão"
    assert f["help_text"] == "Use a data da publicação"
    assert f["options"] == ["Não identificável"]
