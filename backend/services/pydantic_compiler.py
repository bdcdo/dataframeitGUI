"""
Pydantic code compiler for extracting typed fields.

Security note: This module uses Python's exec() to compile user-provided Pydantic code.
This is intentional and necessary — only project coordinators (authenticated, authorized)
can submit Pydantic code. The FastAPI backend runs in an isolated container on Fly.io.
"""
import hashlib
import typing
from typing import get_args, get_origin


def compile_pydantic(code: str) -> dict:
    """
    Compiles Pydantic code and extracts typed fields.
    Returns: { valid: bool, fields: list, model_name: str | None, errors: list }

    Uses exec() intentionally to compile coordinator-provided Pydantic models.
    Access is restricted to authenticated coordinators only.
    """
    namespace: dict = {}
    errors: list[str] = []

    try:
        # exec() is required here to dynamically compile Pydantic model definitions
        # provided by authenticated project coordinators
        compiled = compile(code, "<pydantic_schema>", "exec")  # noqa: S102
        _exec_compiled(compiled, namespace)
    except Exception as e:
        return {"valid": False, "fields": [], "model_name": None, "errors": [str(e)]}

    model_class = find_root_model(namespace)

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

        # If help_text was carried structurally, strip the ". Instrucoes: ..."
        # suffix from description so the returned description is the pure form.
        if help_text:
            suffix = f". Instrucoes: {help_text}"
            if description.endswith(suffix):
                description = description[: -len(suffix)]

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


def _exec_compiled(compiled_code: object, namespace: dict) -> None:
    """Execute pre-compiled code in namespace. Separated for clarity."""
    exec(compiled_code, namespace)  # noqa: S102


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
