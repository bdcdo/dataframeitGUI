"""Recuperação de campos a partir do `pydantic_code` armazenado.

Diferente do endpoint `POST /api/pydantic/validate` removido no #197 (que
recebia código Pydantic arbitrário do cliente — o vetor do #163), este endpoint
recebe apenas um `project_id`: o backend lê `projects.pydantic_code` via service
key e roda `compile_pydantic` (allowlist AST, sem exec). O cliente não consegue
injetar código, então não há vetor de RCE. Existe para repopular o editor visual
quando um projeto legado tem `pydantic_code` mas `pydantic_fields` vazio, e dá a
`compile_pydantic` um chamador de produção (round-trip da regra (b) do CLAUDE.md).

NOTA: quando a auth JWT de rotas (#195) estiver mergeada, este router deve herdar
a mesma proteção das demais rotas — hoje o backend confia no boundary de rede,
igual a `/api/llm/*`.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.pydantic_compiler import compile_pydantic
from services.supabase_client import get_supabase

router = APIRouter()


class RecoverRequest(BaseModel):
    project_id: str


class PydanticFieldOut(BaseModel):
    name: str
    type: str
    options: list[str] | None
    description: str


class RecoverResponse(BaseModel):
    valid: bool
    fields: list[dict]
    model_name: str | None
    errors: list[str]


@router.post("/recover-fields", response_model=RecoverResponse)
async def recover_fields(req: RecoverRequest) -> dict:
    sb = get_supabase()
    result = (
        sb.table("projects")
        .select("pydantic_code")
        .eq("id", req.project_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Projeto não encontrado")
    code = result.data.get("pydantic_code")
    if not code:
        raise HTTPException(
            status_code=404, detail="Projeto não possui código Pydantic armazenado"
        )
    return compile_pydantic(code)
