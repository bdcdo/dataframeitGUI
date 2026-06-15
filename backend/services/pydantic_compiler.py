"""
Pydantic code compiler for extracting typed fields.

Security: este módulo NÃO executa o código do usuário. O schema Pydantic
fornecido pelo coordenador é parseado via AST com uma allowlist estrita
(`build_model_from_code`) e a classe é reconstruída com `pydantic.create_model`
— sem `exec`/`eval`. Isso elimina o vetor de RCE (vuln-0001 / #163): nenhum
import, chamada de função (exceto `Field(...)`), acesso a atributo, dunder,
lambda, comprehension ou decorador é aceito.
"""
import ast
import hashlib
import typing
from typing import Annotated, Any, Literal, Optional, Union, get_args, get_origin


def compile_pydantic(code: str) -> dict:
    """
    Compiles Pydantic code and extracts typed fields.
    Returns: { valid: bool, fields: list, model_name: str | None, errors: list }

    A classe é construída a partir do AST validado (sem exec); a extração de
    metadata abaixo opera sobre a classe reconstruída, igual a antes.
    """
    errors: list[str] = []

    try:
        model_class = build_model_from_code(code)
    except Exception as e:
        return {"valid": False, "fields": [], "model_name": None, "errors": [str(e)]}

    if model_class is None:
        return {
            "valid": False,
            "fields": [],
            "model_name": None,
            "errors": ["Nenhuma classe BaseModel encontrada"],
        }

    fields = []
    for field_name, field_info in model_class.model_fields.items():
        annotation = field_info.annotation
        field_type, options = _parse_annotation(annotation)

        extra = field_info.json_schema_extra or {}
        if callable(extra):
            extra = {}
        is_dict_extra = isinstance(extra, dict)
        target = extra.get("target", "all") if is_dict_extra else "all"
        # Allow json_schema_extra to override the inferred field type (e.g. date)
        explicit_type = extra.get("field_type") if is_dict_extra else None
        if explicit_type:
            field_type = explicit_type
        # Date fields carry options as sentinels in json_schema_extra because
        # the annotation itself is `str`, not Literal.
        if field_type == "date" and is_dict_extra:
            raw_opts = extra.get("options")
            if isinstance(raw_opts, (list, tuple)) and raw_opts:
                options = [str(o) for o in raw_opts]
        description = field_info.description or field_name
        allow_other = (
            bool(extra.get("allowOther", False)) if is_dict_extra else False
        )
        help_text_raw = extra.get("help_text") if is_dict_extra else None
        help_text = help_text_raw.strip() if isinstance(help_text_raw, str) else None
        if not help_text:
            help_text = None
        subfield_rule_raw = extra.get("subfield_rule") if is_dict_extra else None
        subfield_rule = (
            subfield_rule_raw.strip() if isinstance(subfield_rule_raw, str) else None
        ) or None
        condition = _sanitize_condition(
            extra.get("condition") if is_dict_extra else None
        )
        justification_prompt_raw = (
            extra.get("justification_prompt") if is_dict_extra else None
        )
        justification_prompt = (
            justification_prompt_raw.strip()
            if isinstance(justification_prompt_raw, str)
            else None
        ) or None

        # If help_text was carried structurally, strip the ". Instrucoes: ..."
        # suffix from description so the returned description is the pure form.
        if help_text:
            suffix = f". Instrucoes: {help_text}"
            if description.endswith(suffix):
                description = description[: -len(suffix)]

        # Date fields: strip suffixes added by generatePydanticCode so the
        # description round-trips cleanly (otherwise each UI -> compile -> UI
        # cycle accumulates the suffix).
        if field_type == "date":
            if options:
                sentinel_list = ", ".join(f'"{o}"' for o in options)
                sentinel_suffix = (
                    f". Caso não seja possível informar a data, "
                    f"usar um dos seguintes valores: {sentinel_list}"
                )
                if description.endswith(sentinel_suffix):
                    description = description[: -len(sentinel_suffix)]
            date_format_suffix = (
                ". Formato: DD/MM/AAAA (use XX para partes desconhecidas)"
            )
            if description.endswith(date_format_suffix):
                description = description[: -len(date_format_suffix)]

        field_dict: dict = {
            "name": field_name,
            "type": field_type,
            "options": options,
            "description": description,
            "target": target,
            "hash": _field_hash(field_name, field_type, options, description),
        }

        if help_text:
            field_dict["help_text"] = help_text

        if allow_other and field_type in ("single", "multi"):
            field_dict["allow_other"] = True

        # Extract subfields from nested BaseModel
        subfields = _extract_subfields(annotation)
        if subfields:
            field_dict["subfields"] = subfields
            field_dict["subfield_rule"] = subfield_rule or "all"

        if condition is not None:
            field_dict["condition"] = condition

        if justification_prompt:
            field_dict["justification_prompt"] = justification_prompt

        fields.append(field_dict)

    return {
        "valid": True,
        "fields": fields,
        "model_name": model_class.__name__,
        "errors": errors,
    }


def find_root_model(namespace: dict):
    """Return the "main" BaseModel subclass in a namespace, or None.

    Selection rules, in order:
      1. A class explicitly named "Analysis" (the convention of the frontend
         generator) — chosen even if not last, so manually-edited code that
         declares helper classes after the root still works.
      2. A BaseModel that is not referenced by any other BaseModel's fields —
         i.e. the "root" of the type graph. Robust against arbitrary class
         ordering.
      3. Fallback to the last BaseModel defined, matching the generator's
         convention of declaring nested classes before the root.
    """
    from pydantic import BaseModel

    candidates = [
        obj
        for obj in namespace.values()
        if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel
    ]
    if not candidates:
        return None

    analysis = namespace.get("Analysis")
    if analysis in candidates:
        return analysis

    referenced: set[type] = set()
    for cls in candidates:
        for field_info in cls.model_fields.values():
            ann = field_info.annotation
            if (
                isinstance(ann, type)
                and issubclass(ann, BaseModel)
                and ann is not BaseModel
                and ann is not cls
            ):
                referenced.add(ann)
    roots = [c for c in candidates if c not in referenced]
    if len(roots) == 1:
        return roots[0]

    return candidates[-1]


def _field_hash(name: str, field_type: str, options: list[str] | None, description: str) -> str:
    """Stable hash for a field, excluding target."""
    content = f"{name}|{field_type}|{sorted(options) if options else ''}|{description}"
    return hashlib.sha256(content.encode()).hexdigest()[:12]


_CONDITION_OPS = ("equals", "not_equals", "in", "not_in", "exists")


def _sanitize_condition(raw: object) -> dict | None:
    """Return a well-formed condition dict or None.

    Accepts only the shape consumed by ``dataframeit.conditional.evaluate_condition``:
    a dict with ``field`` and exactly one of equals/not_equals/in/not_in/exists.
    """
    if not isinstance(raw, dict):
        return None
    field = raw.get("field")
    if not isinstance(field, str) or not field:
        return None
    for op in _CONDITION_OPS:
        if op in raw:
            value = raw[op]
            if op in ("in", "not_in"):
                if not isinstance(value, list):
                    return None
                return {"field": field, op: list(value)}
            if op == "exists":
                return {"field": field, op: bool(value)}
            return {"field": field, op: value}
    return None


# --------------------------------------------------------------------------
# Construção da classe a partir do AST (sem exec) — allowlist estrita.
# --------------------------------------------------------------------------

class SchemaError(ValueError):
    """Código de schema rejeitado pela allowlist ou inválido."""


# Imports tolerados no topo do schema. Nada além de pydantic/typing é
# necessário para definir os modelos; qualquer outro import é rejeitado.
_ALLOWED_IMPORT_MODULES = {"pydantic", "typing", "typing_extensions", "__future__"}

# Escalares aceitos como anotação de campo.
_SCALAR_TYPES: dict[str, type] = {
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "bytes": bytes,
}

# Nós que jamais aparecem num schema legítimo e abririam espaço para efeito
# colateral / RCE. Rejeitados antes de qualquer construção.
_FORBIDDEN_NODES = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.Lambda,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
    ast.Await,
    ast.Yield,
    ast.YieldFrom,
    ast.Global,
    ast.Nonlocal,
    ast.With,
    ast.AsyncWith,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.If,
    ast.Try,
    ast.Raise,
    ast.Assert,
    ast.Delete,
    ast.Attribute,
    ast.Starred,
    ast.IfExp,
    ast.NamedExpr,
    ast.Import,  # `import x` — ImportFrom permitido só p/ módulos do allowlist
)


def build_model_from_code(code: str):
    """Parseia, valida e reconstrói a classe Pydantic raiz — sem executar nada.

    Retorna a classe (equivalente ao antigo find_root_model do namespace
    exec'd) ou None se nenhum BaseModel for definido. Levanta SchemaError em
    código inválido ou que viole a allowlist.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise SchemaError(f"Código inválido: {e}") from e

    _reject_dangerous(tree)
    namespace = _build_models(tree)
    return find_root_model(namespace)


def _reject_dangerous(tree: ast.AST) -> None:
    """Varre a árvore inteira e rejeita qualquer construção fora da allowlist."""
    for node in ast.walk(tree):
        if isinstance(node, _FORBIDDEN_NODES):
            raise SchemaError(
                f"Construção não permitida no schema: {type(node).__name__}"
            )
        if isinstance(node, ast.ImportFrom):
            if node.module not in _ALLOWED_IMPORT_MODULES:
                raise SchemaError(f"Import não permitido: {node.module}")
        if isinstance(node, ast.ClassDef) and node.decorator_list:
            raise SchemaError("Decoradores não são permitidos em classes do schema")
        # Única chamada permitida é Field(...). Bloqueia open/eval/__import__/etc.
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id == "Field"):
                raise SchemaError("Apenas Field(...) pode ser chamado no schema")
        # Bloqueia dunders (__import__, __class__, __subclasses__, ...).
        if isinstance(node, ast.Name) and "__" in node.id:
            raise SchemaError(f"Identificador não permitido: {node.id}")
        # Só BitOr (X | None) é aceito como operação binária (em anotações).
        if isinstance(node, ast.BinOp) and not isinstance(node.op, ast.BitOr):
            raise SchemaError("Operação não permitida no schema")


def _build_models(tree: ast.Module) -> dict:
    """Constrói todas as classes via create_model, resolvendo dependências.

    Classes podem referenciar umas às outras (campo de tipo BaseModel
    aninhado); constrói em ordem topológica por ponto fixo.
    """
    class_defs = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    names = {cd.name for cd in class_defs}
    built: dict = {}
    pending = list(class_defs)
    while pending:
        progressed = False
        for cd in list(pending):
            deps = _class_dependencies(cd, names)
            if deps <= set(built):
                built[cd.name] = _build_one_class(cd, built)
                pending.remove(cd)
                progressed = True
        if not progressed:
            unresolved = ", ".join(cd.name for cd in pending)
            raise SchemaError(f"Referência de classe não resolvível: {unresolved}")
    return built


def _class_dependencies(cd: ast.ClassDef, local_names: set[str]) -> set[str]:
    """Nomes de classes locais referenciadas pela classe (bases + anotações)."""
    deps: set[str] = set()
    for base in cd.bases:
        if isinstance(base, ast.Name) and base.id in local_names:
            deps.add(base.id)
    for stmt in cd.body:
        if isinstance(stmt, ast.AnnAssign):
            for n in ast.walk(stmt.annotation):
                if isinstance(n, ast.Name) and n.id in local_names:
                    deps.add(n.id)
    return deps


def _build_one_class(cd: ast.ClassDef, built: dict):
    from pydantic import BaseModel, create_model

    base = None
    for b in cd.bases:
        if not isinstance(b, ast.Name):
            raise SchemaError(f"Base de classe inválida em {cd.name}")
        if b.id == "BaseModel":
            base = BaseModel
        elif b.id in built:
            base = built[b.id]
        else:
            raise SchemaError(f"Base desconhecida em {cd.name}: {b.id}")
    if base is None:
        raise SchemaError(f"Classe {cd.name} não herda de BaseModel")

    field_defs: dict = {}
    for stmt in cd.body:
        if isinstance(stmt, ast.AnnAssign):
            if not isinstance(stmt.target, ast.Name):
                raise SchemaError(f"Campo inválido em {cd.name}")
            ftype = _resolve_type(stmt.annotation, built)
            finfo = _build_field(stmt.value)
            field_defs[stmt.target.id] = (ftype, finfo)
        elif isinstance(stmt, ast.Pass):
            continue
        elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            continue  # docstring
        else:
            raise SchemaError(
                f"Statement não permitido no corpo de {cd.name}: "
                f"{type(stmt).__name__}"
            )
    return create_model(cd.name, __base__=base, **field_defs)


def _subscript_slice(node: ast.Subscript) -> ast.AST:
    # Em Python 3.9+ o slice é a expressão direta (Index foi removido).
    return node.slice


def _slice_elements(sl: ast.AST) -> list[ast.AST]:
    return list(sl.elts) if isinstance(sl, ast.Tuple) else [sl]


def _resolve_type(node: ast.AST, built: dict):
    """Converte um nó de anotação de tipo num objeto de tipo real (sem eval)."""
    if isinstance(node, ast.Name):
        if node.id in _SCALAR_TYPES:
            return _SCALAR_TYPES[node.id]
        if node.id in built:
            return built[node.id]
        if node.id == "Any":
            return Any
        raise SchemaError(f"Tipo não suportado: {node.id}")

    if isinstance(node, ast.Constant):
        if node.value is None:
            return type(None)
        raise SchemaError(f"Anotação inválida: {node.value!r}")

    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return Union[_resolve_type(node.left, built), _resolve_type(node.right, built)]

    if isinstance(node, ast.Subscript):
        if not isinstance(node.value, ast.Name):
            raise SchemaError("Construtor de tipo inválido")
        ctor = node.value.id
        sl = _subscript_slice(node)
        if ctor == "Literal":
            values = tuple(_literal_value(e) for e in _slice_elements(sl))
            return Literal[values]
        if ctor in ("list", "List"):
            return list[_resolve_type(_single_arg(sl), built)]
        if ctor == "Optional":
            return Optional[_resolve_type(_single_arg(sl), built)]
        if ctor == "Union":
            return Union[tuple(_resolve_type(e, built) for e in _slice_elements(sl))]
        if ctor == "Annotated":
            elts = _slice_elements(sl)
            inner = _resolve_type(elts[0], built)
            meta = [_safe_literal(e) for e in elts[1:]]
            return Annotated[tuple([inner, *meta])]
        if ctor in ("dict", "Dict"):
            k, v = _slice_elements(sl)
            return dict[_resolve_type(k, built), _resolve_type(v, built)]
        if ctor in ("tuple", "Tuple"):
            return tuple[tuple(_resolve_type(e, built) for e in _slice_elements(sl))]
        raise SchemaError(f"Construtor de tipo não suportado: {ctor}")

    raise SchemaError(f"Anotação de tipo inválida: {type(node).__name__}")


def _single_arg(sl: ast.AST) -> ast.AST:
    if isinstance(sl, ast.Tuple):
        raise SchemaError("Esperado um único argumento de tipo")
    return sl


def _literal_value(node: ast.AST):
    """Valor de um membro de Literal[...] — só constantes."""
    if isinstance(node, ast.Constant):
        return node.value
    raise SchemaError("Literal aceita apenas constantes")


def _build_field(value: ast.AST | None):
    """Reconstrói o Field(...)/default do campo a partir do AST."""
    from pydantic import Field

    if value is None:
        return ...  # campo sem default → required
    if isinstance(value, ast.Call):
        # _reject_dangerous já garantiu func == Field
        args = [_field_default(a) for a in value.args]
        kwargs: dict = {}
        for kw in value.keywords:
            if kw.arg is None:
                raise SchemaError("**kwargs não permitido em Field(...)")
            kwargs[kw.arg] = _safe_literal(kw.value)
        return Field(*args, **kwargs)
    # Default literal direto (ex.: `x: int = 5`)
    return Field(default=_safe_literal(value))


def _field_default(node: ast.AST):
    if isinstance(node, ast.Constant) and node.value is ...:
        return ...
    return _safe_literal(node)


def _safe_literal(node: ast.AST):
    """Avalia um nó como literal Python (str/num/bool/None/list/dict/tuple/...).

    Usa ast.literal_eval, que NÃO chama funções nem acessa atributos — só
    avalia literais. Nomes (variáveis) e chamadas levantam erro (fail-closed).
    """
    try:
        return ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError) as e:
        raise SchemaError("Valor não literal no schema") from e


def _parse_annotation(annotation: type) -> tuple[str, list[str] | None]:
    """Parse a type annotation into (type, options)."""
    origin = get_origin(annotation)
    args = get_args(annotation)

    # Literal["A", "B"] -> single choice
    if origin is typing.Literal:
        return "single", [str(a) for a in args]

    # list[Literal["A", "B"]] -> multi choice
    if origin is list:
        if args:
            inner_origin = get_origin(args[0])
            inner_args = get_args(args[0])
            if inner_origin is typing.Literal:
                return "multi", [str(a) for a in inner_args]

    # str -> text
    if annotation is str:
        return "text", None

    # Optional[X] -> unwrap
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _parse_annotation(non_none[0])

    # Nested BaseModel -> composite text field
    from pydantic import BaseModel
    if isinstance(annotation, type) and issubclass(annotation, BaseModel) and annotation is not BaseModel:
        return "text", None  # type stays "text"; subfields extracted separately

    return "text", None


def _extract_subfields(annotation: type) -> list[dict] | None:
    """Extract subfield definitions from a nested BaseModel annotation."""
    from pydantic import BaseModel
    if not (isinstance(annotation, type) and issubclass(annotation, BaseModel) and annotation is not BaseModel):
        return None
    subfields = []
    for sf_name, sf_info in annotation.model_fields.items():
        sf_ann = sf_info.annotation
        # Check if Optional (i.e., not required)
        is_optional = False
        sf_origin = get_origin(sf_ann)
        if sf_origin is typing.Union:
            sf_args = get_args(sf_ann)
            is_optional = type(None) in sf_args
        subfields.append({
            "key": sf_name,
            "label": sf_info.description or sf_name,
            "required": not is_optional,
        })
    return subfields if subfields else None
