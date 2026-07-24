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
from typing import Literal, Optional, get_args, get_origin


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

    fields = [
        _build_field_dict(field_name, field_info)
        for field_name, field_info in model_class.model_fields.items()
    ]

    return {
        "valid": True,
        "fields": fields,
        "model_name": model_class.__name__,
        "errors": errors,
    }


def extract_json_schema_extra(field_info) -> dict:
    """Normaliza `json_schema_extra` para sempre ser um dict (nunca callable).

    Público de propósito: compartilhado com `condition_evaluator.py` e
    `llm_runner.py`, que faziam a mesma checagem `callable`/`isinstance(dict)`
    de forma independente (achado da revisão do PR #379) — este é o único
    lugar que deve fazer essa normalização.
    """
    extra = field_info.json_schema_extra or {}
    if callable(extra) or not isinstance(extra, dict):
        return {}
    return extra


def _normalize_optional_str(raw) -> str | None:
    """Trim de sentinela de string; retorna None se vazio/ausente."""
    return (raw.strip() if isinstance(raw, str) else None) or None


def _resolve_field_type_and_options(
    field_type: str, options: list[str] | None, extra: dict
) -> tuple[str, list[str] | None]:
    """Aplica override explícito de tipo e sentinelas de opções de campo date."""
    # Allow json_schema_extra to override the inferred field type (e.g. date)
    explicit_type = extra.get("field_type")
    if explicit_type:
        field_type = explicit_type
    # Date fields carry options as sentinels in json_schema_extra because the
    # annotation itself is `str`, not Literal.
    if field_type == "date":
        raw_opts = extra.get("options")
        if isinstance(raw_opts, (list, tuple)) and raw_opts:
            options = [str(o) for o in raw_opts]
    return field_type, options


def _strip_description_suffixes(
    description: str, field_type: str, options: list[str] | None, help_text: str | None
) -> str:
    """Remove sufixos que `generatePydanticCode` acrescenta à description.

    Evita que o round-trip UI -> compile -> UI acumule o sufixo a cada ciclo.
    """
    if help_text:
        suffix = f". Instrucoes: {help_text}"
        if description.endswith(suffix):
            description = description[: -len(suffix)]

    if field_type == "date":
        if options:
            sentinel_list = ", ".join(f'"{o}"' for o in options)
            sentinel_suffix = (
                f". Caso não seja possível informar a data, "
                f"usar um dos seguintes valores: {sentinel_list}"
            )
            if description.endswith(sentinel_suffix):
                description = description[: -len(sentinel_suffix)]
        date_format_suffix = ". Formato: DD/MM/AAAA (use XX para partes desconhecidas)"
        if description.endswith(date_format_suffix):
            description = description[: -len(date_format_suffix)]

    return description


def _assemble_field_dict(
    field_name: str,
    field_type: str,
    options: list[str] | None,
    description: str,
    target: str,
    help_text: str | None,
    required: bool,
    allow_other: bool,
    subfields: list[dict] | None,
    subfield_rule: str | None,
    condition: dict | None,
    justification_prompt: str | None,
) -> dict:
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

    # Espelha o gerador (`fieldExtra` em schema-utils.ts): só o caso não-default
    # é representado, aqui e no código. O default de `required` é True, ao
    # contrário do `required` de subcampo, que é portado pela anotação
    # (Optional[str]) e cujo default é False — ver `_extract_subfields`.
    if not required:
        field_dict["required"] = False

    if allow_other and field_type in ("single", "multi"):
        field_dict["allow_other"] = True

    if subfields:
        field_dict["subfields"] = subfields
        field_dict["subfield_rule"] = subfield_rule or "all"

    if condition is not None:
        field_dict["condition"] = condition

    if justification_prompt:
        field_dict["justification_prompt"] = justification_prompt

    return field_dict


def _build_field_dict(field_name: str, field_info) -> dict:
    """Reconstitui o dict de metadata de `PydanticField` para um campo compilado."""
    annotation = field_info.annotation
    parsed_type, parsed_options = _parse_annotation(annotation)
    extra = extract_json_schema_extra(field_info)

    field_type, options = _resolve_field_type_and_options(
        parsed_type, parsed_options, extra
    )
    description = field_info.description or field_name
    help_text = _normalize_optional_str(extra.get("help_text"))
    description = _strip_description_suffixes(
        description, field_type, options, help_text
    )

    return _assemble_field_dict(
        field_name=field_name,
        field_type=field_type,
        options=options,
        description=description,
        target=extra.get("target", "all"),
        help_text=help_text,
        required=bool(extra.get("required", True)),
        allow_other=bool(extra.get("allowOther", False)),
        subfields=_extract_subfields(annotation),
        subfield_rule=_normalize_optional_str(extra.get("subfield_rule")),
        condition=_sanitize_condition(extra.get("condition")),
        justification_prompt=_normalize_optional_str(extra.get("justification_prompt")),
    )


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


def _field_hash(
    name: str, field_type: str, options: list[str] | None, description: str
) -> str:
    """Stable hash for a field, excluding target."""
    content = f"{name}|{field_type}|{sorted(options) if options else ''}|{description}"
    return hashlib.sha256(content.encode()).hexdigest()[:12]


CONDITION_OPERATORS = ("equals", "not_equals", "in", "not_in", "exists")
"""Lista canônica de operadores de condição suportados.

Público de propósito: é a única fonte de verdade para o vocabulário de
operadores — `condition_evaluator._CONDITION_HANDLERS` deriva sua ordem de
dispatch daqui em vez de manter uma segunda lista independente (achado da
revisão do PR #379).
"""


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
    for op in CONDITION_OPERATORS:
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
    """Código de schema rejeitado pela allowlist ou inválido.

    Carrega ``lineno``/``offset`` quando a origem do erro tem posição conhecida
    (ex.: ``SyntaxError`` do ``ast.parse``), para que o runner consiga apontar a
    linha do schema ao coordenador (ver ``llm_runner._extract_pydantic_location``).
    ``None`` quando a posição não é localizável (ex.: violação de allowlist sobre
    um nó sem linha relevante).
    """

    def __init__(
        self, *args: object, lineno: int | None = None, offset: int | None = None
    ):
        super().__init__(*args)
        self.lineno = lineno
        self.offset = offset


# Imports tolerados no topo do schema. Nada além de pydantic/typing é
# necessário para definir os modelos; qualquer outro import é rejeitado.
_ALLOWED_IMPORT_MODULES = {"pydantic", "typing", "typing_extensions", "__future__"}

# Tamanho máximo do código de schema. O código é gerado pela GUI
# (`generatePydanticCode`) e nunca chega perto disso; o limite só existe como
# defense-in-depth para barrar um `projects.pydantic_code` patológico antes de
# `ast.parse`, evitando custo de parsing/recursão sobre entrada gigante.
_MAX_CODE_LENGTH = 64 * 1024

# Escalares aceitos como anotação de campo.
_SCALAR_TYPES: dict[str, type] = {
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
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

# Profundidade máxima de aninhamento de anotações de tipo. A anotação mais
# profunda que `generatePydanticCode` emite é `list[Literal[...]]` (profundidade
# ~2); 20 é folgado de propósito. O limite só existe para transformar um
# aninhamento patológico num SchemaError claro em vez de RecursionError.
_MAX_TYPE_DEPTH = 20


def build_model_from_code(code: str):
    """Parseia, valida e reconstrói a classe Pydantic raiz — sem executar nada.

    Aceita **exatamente** a grammar que ``generatePydanticCode`` (frontend)
    emite — o único produtor legítimo de ``projects.pydantic_code`` desde que a
    edição manual foi descontinuada na UI (#197):

    - imports só de ``pydantic``/``typing``;
    - classes ``BaseModel`` com herança única;
    - anotações ``str`` (e demais escalares de ``_SCALAR_TYPES``),
      ``Literal[...]``, ``list[Literal[...]]``, ``Optional[...]`` e ``BaseModel``
      aninhado;
    - ``Field(...)`` com valores literais (``ast.literal_eval``, que não chama
      funções) — incluindo ``json_schema_extra={...}``.

    Tudo fora disso — ``Annotated[...]``, ``dict``/``tuple``/``Union[...]``,
    união ``X | None``, herança múltipla, import arbitrário, chamada que não
    ``Field``, acesso a atributo, dunder estrito, lambda, comprehension,
    decorador — é rejeitado com ``SchemaError`` (defense-in-depth). A allowlist
    é deliberadamente estreita: casa só o seu produtor, sem suportar Pydantic
    arbitrário.

    Retorna a classe raiz (ver ``find_root_model``) ou ``None`` se nenhum
    ``BaseModel`` for definido. Levanta ``SchemaError`` (sempre — nunca um
    ``ValueError``/``TypeError`` cru) em código inválido ou que viole a
    allowlist.
    """
    if len(code) > _MAX_CODE_LENGTH:
        raise SchemaError("Código de schema excede o tamanho máximo permitido")
    try:
        tree = ast.parse(code, filename="<pydantic_schema>")
    except SyntaxError as e:
        raise SchemaError(
            f"Código inválido: {e}", lineno=e.lineno, offset=e.offset
        ) from e

    _reject_dangerous(tree)
    # _build_models/_resolve_type só devem levantar SchemaError; qualquer
    # exceção inesperada (ex.: TypeError de typing, ValueError de unpack) é
    # encapsulada para honrar o contrato e dar mensagem coerente ao usuário.
    try:
        namespace = _build_models(tree)
    except SchemaError:
        raise
    except Exception as e:  # noqa: BLE001 — converte para o tipo de erro do contrato
        raise SchemaError(str(e) or type(e).__name__) from e
    return find_root_model(namespace)


def _is_strict_dunder(name: str) -> bool:
    """True para identificadores que começam E terminam com "__".

    Nomes legítimos com "__" interno (ex.: my__field) ou de borda (a classe
    aninhada _doc__fields gerada de um campo terminando em "_") são liberados;
    só os dunders estritos (__import__, __class__, __subclasses__, ...) são
    atributos mágicos/builtins perigosos. Espelha o `isStrictDunder` do
    frontend (schema-utils.ts).
    """
    return name.startswith("__") and name.endswith("__")


def _reject_dangerous(tree: ast.AST) -> None:  # noqa: C901
    """Varre a árvore inteira e rejeita qualquer construção fora da allowlist.

    Isenta de C901 (14 > 10) de propósito: é o vetor de segurança contra
    execução arbitrária no schema editável pelo usuário. Cada `if` é uma
    checagem de allowlist independente dentro do mesmo `ast.walk` — extrair
    sub-funções não fragmentaria o walk (cada checagem viraria uma função
    chamada por iteração), mas a isenção se mantém porque decompor um trecho
    de segurança fora de uma revisão dedicada arrisca introduzir uma brecha
    sem reduzir o risco real. Refactor dedicado (não de tooling) exigiria
    revisão de segurança à parte. Ver #376.
    """
    for node in ast.walk(tree):
        if isinstance(node, _FORBIDDEN_NODES):
            raise SchemaError(
                f"Construção não permitida no schema: {type(node).__name__}"
            )
        if isinstance(node, ast.ImportFrom):
            if node.module not in _ALLOWED_IMPORT_MODULES:
                raise SchemaError(f"Import não permitido: {node.module}")
        if isinstance(node, ast.ClassDef):
            if node.decorator_list:
                raise SchemaError("Decoradores não são permitidos em classes do schema")
            # Nome da classe não é um ast.Name (é str), então não passa pela
            # checagem de Name abaixo — valida aqui (ex.: class __reduce__(...)).
            if _is_strict_dunder(node.name):
                raise SchemaError(f"Nome de classe não permitido: {node.name}")
        # Única chamada permitida é Field(...). Bloqueia open/eval/__import__/etc.
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id == "Field"):
                raise SchemaError("Apenas Field(...) pode ser chamado no schema")
            # Nomes de kwarg também são str, não ast.Name; um dunder estrito
            # como Field(__class__=...) ou json_schema_extra de chave dunder
            # passaria despercebido sem esta checagem.
            for kw in node.keywords:
                if kw.arg is not None and _is_strict_dunder(kw.arg):
                    raise SchemaError(
                        f"Argumento não permitido em Field(...): {kw.arg}"
                    )
        # Bloqueia dunders estritos escritos como identificador (ast.Name).
        if isinstance(node, ast.Name) and _is_strict_dunder(node.id):
            raise SchemaError(f"Identificador não permitido: {node.id}")
        # Nenhuma operação binária é válida no schema gerado (Optional[...] é
        # usado no lugar de `X | None`). Rejeita todas.
        if isinstance(node, ast.BinOp):
            raise SchemaError("Operação não permitida no schema")


def _build_models(tree: ast.Module) -> dict:
    """Constrói todas as classes via create_model, resolvendo dependências.

    Classes podem referenciar umas às outras (campo de tipo BaseModel
    aninhado); constrói em ordem topológica por ponto fixo.
    """
    class_defs = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    names = {cd.name for cd in class_defs}
    # Dependências computadas uma única vez por classe (cada `_class_dependencies`
    # faz `ast.walk` das anotações); o loop abaixo só testa pertinência contra o
    # conjunto já construído, mantido incrementalmente — O(N) walks, não O(N²).
    deps_by_name = {cd.name: _class_dependencies(cd, names) for cd in class_defs}
    built: dict = {}
    built_names: set[str] = set()
    pending = list(class_defs)
    while pending:
        progressed = False
        for cd in list(pending):
            if deps_by_name[cd.name] <= built_names:
                built[cd.name] = _build_one_class(cd, built)
                built_names.add(cd.name)
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

    # O gerador só emite herança única de BaseModel (ou de uma classe aninhada).
    # Herança múltipla não é suportada e antes era colapsada em silêncio para a
    # última base, descartando campos — agora é rejeitada explicitamente.
    if len(cd.bases) != 1:
        raise SchemaError(
            f"Classe {cd.name} deve herdar de exatamente uma base (BaseModel)"
        )
    b = cd.bases[0]
    if not isinstance(b, ast.Name):
        raise SchemaError(f"Base de classe inválida em {cd.name}")
    if b.id == "BaseModel":
        base = BaseModel
    elif b.id in built:
        base = built[b.id]
    else:
        raise SchemaError(f"Base desconhecida em {cd.name}: {b.id}")

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
                f"Statement não permitido no corpo de {cd.name}: {type(stmt).__name__}"
            )
    return create_model(cd.name, __base__=base, **field_defs)


def _slice_elements(sl: ast.AST) -> list[ast.AST]:
    return list(sl.elts) if isinstance(sl, ast.Tuple) else [sl]


def _resolve_type(node: ast.AST, built: dict, depth: int = 0):  # noqa: C901
    """Converte um nó de anotação de tipo num objeto de tipo real (sem eval).

    Suporta apenas a grammar do gerador: escalares (``_SCALAR_TYPES``), classes
    aninhadas, ``Literal[...]``, ``list[...]`` e ``Optional[...]``. Construtores
    como ``Annotated``/``dict``/``tuple``/``Union`` (e união ``X | None``, já
    barrada em ``_reject_dangerous``) não são emitidos pelo gerador e viram
    ``SchemaError`` limpo.

    Isenta de C901 (12 > 10) de propósito. Diferente de `_reject_dangerous`,
    aqui não há um único `ast.walk` cuja fragmentação seja o argumento
    central: é dispatch recursivo por tipo de nó AST, e alguns ramos (ex.:
    Literal/list/Optional em `ast.Subscript`) poderiam em tese virar funções
    auxiliares sem quebrar a recursão. A isenção existe pela mesma cautela de
    `_reject_dangerous` — é a allowlist de tipos aceitos no schema editável
    pelo usuário, e decompor esse trecho fora de uma revisão de segurança
    dedicada arrisca introduzir uma brecha sem reduzir o risco real. Ver #376.
    """
    if depth > _MAX_TYPE_DEPTH:
        raise SchemaError("Anotação de tipo aninhada demais")
    if isinstance(node, ast.Name):
        if node.id in _SCALAR_TYPES:
            return _SCALAR_TYPES[node.id]
        if node.id in built:
            return built[node.id]
        raise SchemaError(f"Tipo não suportado: {node.id}")

    if isinstance(node, ast.Constant):
        if node.value is None:
            return type(None)
        raise SchemaError(f"Anotação inválida: {node.value!r}")

    if isinstance(node, ast.Subscript):
        if not isinstance(node.value, ast.Name):
            raise SchemaError("Construtor de tipo inválido")
        ctor = node.value.id
        sl = node.slice  # Python 3.9+: o slice é a expressão direta.
        if ctor == "Literal":
            values = tuple(_literal_value(e) for e in _slice_elements(sl))
            return Literal[values]
        if ctor in ("list", "List"):
            # list[T] com T resolvido em runtime: diferente de Optional[...]
            # (SpecialForm mais permissivo), o mypy exige que o parametro do
            # generico builtin list[...] seja reconhecivel estaticamente como
            # type[...]; nao ha como expressar isso sem reescrever o compilador
            # para eval (o que _resolve_type existe justamente para evitar).
            return list[_resolve_type(_single_arg(sl), built, depth + 1)]  # type: ignore[misc]
        if ctor == "Optional":
            return Optional[_resolve_type(_single_arg(sl), built, depth + 1)]
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
        # _reject_dangerous já garantiu func == Field. _safe_literal trata
        # `...` (literal_eval retorna Ellipsis), então não há caso especial.
        args = [_safe_literal(a) for a in value.args]
        kwargs: dict = {}
        for kw in value.keywords:
            if kw.arg is None:
                raise SchemaError("**kwargs não permitido em Field(...)")
            kwargs[kw.arg] = _safe_literal(kw.value)
        return Field(*args, **kwargs)
    # Default literal direto (ex.: `x: int = 5`)
    return Field(default=_safe_literal(value))


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

    if (
        isinstance(annotation, type)
        and issubclass(annotation, BaseModel)
        and annotation is not BaseModel
    ):
        return "text", None  # type stays "text"; subfields extracted separately

    return "text", None


def _extract_subfields(annotation: type) -> list[dict] | None:
    """Extract subfield definitions from a nested BaseModel annotation."""
    from pydantic import BaseModel

    if not (
        isinstance(annotation, type)
        and issubclass(annotation, BaseModel)
        and annotation is not BaseModel
    ):
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
        # Sob subfield_rule="at_least_one" a anotação é sempre Optional, então
        # ela não consegue carregar o `required` individual — o gerador o
        # transporta em json_schema_extra e o extra prevalece sobre a anotação
        # (issue #491; mesmo padrão do `required` de campo, PR #454).
        #
        # A chave é `subfield_required` porque `_flatten_nested_basemodels`
        # (services/llm_runner.py) reaproveita este FieldInfo inteiro ao achatar
        # o modelo para o LLM: o extra vira uma *property* do JSON Schema
        # mandado ao provider, e `required` ali é palavra reservada com outra
        # semântica (array no nível do objeto). Ver generatePydanticCode.
        sf_extra = extract_json_schema_extra(sf_info)
        subfields.append(
            {
                "key": sf_name,
                "label": sf_info.description or sf_name,
                "required": bool(sf_extra.get("subfield_required", not is_optional)),
            }
        )
    return subfields if subfields else None
