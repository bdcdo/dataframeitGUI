from fastapi import APIRouter, Depends
from pydantic import BaseModel

from services.auth import AuthUser, require_authenticated_user
from services.pydantic_compiler import compile_pydantic

router = APIRouter()


class ValidateRequest(BaseModel):
    code: str


class PydanticField(BaseModel):
    name: str
    type: str
    options: list[str] | None
    description: str


class ValidateResponse(BaseModel):
    valid: bool
    fields: list[PydanticField]
    model_name: str | None
    errors: list[str]


@router.post("/validate", response_model=ValidateResponse)
async def validate_pydantic(
    req: ValidateRequest,
    user: AuthUser = Depends(require_authenticated_user),
):
    # Exige autenticação: a compilação roda no processo do backend. O PR de
    # AST allowlist elimina o exec() de fato; aqui fechamos a exposição anônima.
    result = compile_pydantic(req.code)
    return result
