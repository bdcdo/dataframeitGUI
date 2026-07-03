"""Avaliação de condições de visibilidade de campos.

Porta a semântica de ``frontend/src/lib/conditional.ts`` para Python, para que o
pruning de respostas no backend concorde com a visibilidade do campo na UI. O
``evaluate_condition`` original de ``dataframeit`` diverge em três casos:

- ``not_equals``/``not_in`` com gatilho ausente — Python trata ``None != "x"``
  como True (mantém); o frontend esconde.
- ``exists: True`` com ``""`` ou ``[]`` — ``dataframeit`` só checa ``is not None``;
  o frontend também considera string/array vazios como "não existe".

Manter as semânticas alinhadas evita respostas órfãs (armazenadas no banco,
invisíveis na UI de coding).
"""

from typing import Any


def _get_nested(data: dict, path: str) -> Any:
    if not path:
        return None
    current: Any = data
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
        if current is None:
            return None
    return current


def _scalar_equals(a: Any, b: Any) -> bool:
    # Alinhado com ``scalarEquals`` do frontend: só compara quando os tipos
    # batem, para evitar coerções surpresa (e.g. ``"1" == 1``).
    if type(a) is type(b):
        return a == b
    # Python trata bool como int; o frontend tem tipos distintos.
    if isinstance(a, bool) or isinstance(b, bool):
        return False
    # Aceita int vs float do mesmo valor como equivalentes (ambos "number" no TS).
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return False


def _matches_scalar(value: Any, target: Any) -> bool:
    if isinstance(value, list):
        return any(_scalar_equals(v, target) for v in value)
    return _scalar_equals(value, target)


def _eval_equals(value: Any, condition: dict) -> bool:
    return _matches_scalar(value, condition["equals"])


def _eval_not_equals(value: Any, condition: dict) -> bool:
    if value is None:
        return False
    return not _matches_scalar(value, condition["not_equals"])


def _eval_in(value: Any, condition: dict) -> bool:
    targets = condition["in"]
    if not isinstance(targets, list):
        return False
    return any(_matches_scalar(value, t) for t in targets)


def _eval_not_in(value: Any, condition: dict) -> bool:
    if value is None:
        return False
    targets = condition["not_in"]
    if not isinstance(targets, list):
        return False
    return not any(_matches_scalar(value, t) for t in targets)


def _eval_exists(value: Any, condition: dict) -> bool:
    exists = (
        value is not None
        and not (isinstance(value, str) and value == "")
        and not (isinstance(value, list) and len(value) == 0)
    )
    return exists == bool(condition["exists"])


# Ordem importa: replica a prioridade do antigo if/elif quando mais de uma
# chave de operador aparece no mesmo dict de condicao (nao deveria acontecer,
# mas a primeira chave presente ganha, igual antes).
_CONDITION_HANDLERS = {
    "equals": _eval_equals,
    "not_equals": _eval_not_equals,
    "in": _eval_in,
    "not_in": _eval_not_in,
    "exists": _eval_exists,
}


def evaluate_condition(condition: Any, field_data: dict, field_name: str = "") -> bool:
    """True se o campo deve estar visível dadas as respostas atuais."""
    if condition is None:
        return True
    if not isinstance(condition, dict):
        return False

    field_path = condition.get("field")
    if not isinstance(field_path, str) or not field_path:
        return False

    value = _get_nested(field_data, field_path)

    for operator, handler in _CONDITION_HANDLERS.items():
        if operator in condition:
            return handler(value, condition)
    return False


def extract_field_conditions(model_class) -> dict:
    """Lê condições do modelo Pydantic compilado.

    Fonte de verdade: ``json_schema_extra["condition"]`` do campo (populado por
    ``generatePydanticCode`` e lido por ``compile_pydantic``). Nunca ler de
    ``projects.pydantic_fields`` — regra do CLAUDE.md.
    """
    result: dict = {}
    for field_name, field_info in model_class.model_fields.items():
        extra = field_info.json_schema_extra
        if callable(extra) or not isinstance(extra, dict):
            continue
        cond = extra.get("condition")
        if isinstance(cond, dict):
            result[field_name] = cond
    return result
