"""
Pydantic code compiler for extracting typed fields.

Security note: This module uses Python's exec() to compile user-provided Pydantic code.
This is intentional and necessary — only project coordinators (authenticated, authorized)
can submit Pydantic code. The FastAPI backend runs in an isolated container on Fly.io.
"""
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

    # Find the BaseModel subclass
    from pydantic import BaseModel

    model_class = None
    for name, obj in namespace.items():
        if (
            isinstance(obj, type)
            and issubclass(obj, BaseModel)
            and obj is not BaseModel
        ):
            model_class = obj
            break

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

        fields.append(
            {
                "name": field_name,
                "type": field_type,
                "options": options,
                "description": field_info.description or field_name,
            }
        )

    return {
        "valid": True,
        "fields": fields,
        "model_name": model_class.__name__,
        "errors": errors,
    }


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

    return "text", None
