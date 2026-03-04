from fastapi import APIRouter
from pydantic import BaseModel

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
async def validate_pydantic(req: ValidateRequest):
    result = compile_pydantic(req.code)
    return result
