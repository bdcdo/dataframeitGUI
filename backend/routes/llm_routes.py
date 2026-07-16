import uuid
from typing import Annotated, Literal, Self, TypeVar

from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.concurrency import run_in_threadpool
from pydantic import (
    AfterValidator,
    BaseModel,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from routes.request_models import StrictRequestModel
from services.auth import (
    AuthUser,
    require_authenticated_user,
    require_job_access,
    require_project_coordinator,
)
from services.llm_rate_limiter import enforce_llm_rate_limit
from services.llm_runner import (
    _build_prompt,
    get_job_status,
    init_job,
    mark_stale_runs_as_error,
    run_llm,
    run_llm_fields,
)
from services.supabase_client import get_supabase

router = APIRouter()


UniqueValue = TypeVar("UniqueValue", uuid.UUID, str)


def _ensure_unique(values: list[UniqueValue], field_name: str) -> list[UniqueValue]:
    if len(values) != len(set(values)):
        raise ValueError(f"{field_name} must not contain duplicates")
    return values


def _reject_duplicate_document_ids(values: list[uuid.UUID]) -> list[uuid.UUID]:
    return _ensure_unique(values, "document_ids")


# Uniqueness travels with the type so both request models inherit it from one
# place; only the reject reason (dunder names) differs for field_names below.
DocumentIds = Annotated[
    list[uuid.UUID],
    Field(min_length=1, max_length=10_000),
    AfterValidator(_reject_duplicate_document_ids),
]
FieldName = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z_][A-Za-z0-9_]*$",
    ),
]


class RunRequest(StrictRequestModel):
    project_id: uuid.UUID
    document_ids: DocumentIds | None = None
    filter_mode: Literal["all", "pending", "max_responses", "random_sample"] = "all"
    max_response_count: Annotated[int, Field(strict=True, ge=0, le=1_000)] | None = None
    sample_size: Annotated[int, Field(strict=True, ge=1, le=10_000)] | None = None

    @model_validator(mode="after")
    def required_filter_parameter_present(self) -> Self:
        # Only enforce that the parameter each mode needs is present. A parameter
        # supplied for another mode is ignored downstream (run_llm reads each one
        # solely in its own mode), so there is no reason to reject it here.
        if self.filter_mode == "random_sample" and self.sample_size is None:
            raise ValueError("sample_size is required for random_sample")
        if self.filter_mode == "max_responses" and self.max_response_count is None:
            raise ValueError("max_response_count is required for max_responses")
        return self


class RunFieldRequest(StrictRequestModel):
    project_id: uuid.UUID
    field_names: Annotated[list[FieldName], Field(min_length=1, max_length=500)]
    document_ids: DocumentIds | None = None

    @field_validator("field_names")
    @classmethod
    def field_names_are_unique(cls, value: list[str]) -> list[str]:
        if any(name.startswith("__") and name.endswith("__") for name in value):
            raise ValueError("field_names must not contain reserved dunder names")
        return _ensure_unique(value, "field_names")


class RunResponse(BaseModel):
    job_id: str


class StatusResponse(BaseModel):
    status: str
    phase: str = "loading"
    progress: int
    total: int
    errors: list[str]
    eta_seconds: float | None = None
    current_batch: int = 0
    total_batches: int = 0
    # Populated only when status == "error"
    error_traceback: str | None = None
    error_type: str | None = None
    error_line: int | None = None
    error_column: int | None = None
    # Snapshot of the pydantic_code used in this run — sent with errors so the
    # frontend can render the code window against the actual failed version,
    # not the project's current (possibly edited) code.
    pydantic_code: str | None = None
    # Counters ao vivo durante a fase de saving — quantos documentos saíram
    # completos / parciais (cobertura baixa) / vazios (sem nenhum field). Default
    # 0 e disponíveis assim que o save loop começa a inserir respostas. Vê
    # llm_runner.py:_answers_have_content para a regra de classificação.
    processed_complete: int = 0
    processed_partial: int = 0
    processed_empty: int = 0


@router.post("/run", response_model=RunResponse)
async def run(
    req: RunRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(require_authenticated_user),
):
    # run_in_threadpool: o guard é síncrono e faz I/O bloqueante no Supabase;
    # chamado direto aqui rodaria no thread do event loop. Tira do loop.
    project_id = str(req.project_id)
    document_ids = (
        [str(document_id) for document_id in req.document_ids]
        if req.document_ids is not None
        else None
    )
    await run_in_threadpool(require_project_coordinator, project_id, user)
    await run_in_threadpool(enforce_llm_rate_limit, project_id, user.id)
    job_id = str(uuid.uuid4())
    # Síncrono: insere a row de llm_runs ANTES do background task. Se falhar
    # (RLS, conexão, payload), a request retorna 500 e o frontend mostra o erro
    # em vez de ficar com job fantasma que nunca aparece em Execuções.
    init_job(job_id, project_id, req.filter_mode)
    background_tasks.add_task(
        run_llm,
        job_id,
        project_id,
        document_ids,
        req.filter_mode,
        req.max_response_count,
        req.sample_size,
    )
    return {"job_id": job_id}


@router.post("/run-field", response_model=RunResponse)
async def run_field(
    req: RunFieldRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(require_authenticated_user),
):
    project_id = str(req.project_id)
    document_ids = (
        [str(document_id) for document_id in req.document_ids]
        if req.document_ids is not None
        else None
    )
    await run_in_threadpool(require_project_coordinator, project_id, user)
    await run_in_threadpool(enforce_llm_rate_limit, project_id, user.id)
    job_id = str(uuid.uuid4())
    # filter_mode "all" porque run-field não tem semântica de subset; o
    # subset é o conjunto de fields, não de docs.
    init_job(job_id, project_id, "all")
    background_tasks.add_task(
        run_llm_fields, job_id, project_id, req.field_names, document_ids
    )
    return {"job_id": job_id}


@router.get("/status/{job_id}", response_model=StatusResponse)
async def status(
    job_id: uuid.UUID,
    user: AuthUser = Depends(require_authenticated_user),
):
    job_id_value = str(job_id)
    await run_in_threadpool(require_job_access, job_id_value, user)
    return get_job_status(job_id_value)


class CleanupRequest(StrictRequestModel):
    project_id: uuid.UUID


class CleanupResponse(BaseModel):
    cleaned: int


class PreviewPromptRequest(StrictRequestModel):
    project_description: Annotated[str, Field(max_length=50_000)] | None = None
    prompt_template: Annotated[str, Field(max_length=50_000)] | None = None


class PreviewPromptResponse(BaseModel):
    prompt: str


@router.post("/preview-prompt", response_model=PreviewPromptResponse)
async def preview_prompt(
    req: PreviewPromptRequest,
    user: AuthUser = Depends(require_authenticated_user),
):
    """Monta o prompt final igual ao usado na execução real.

    Single source of truth: o frontend (LlmConfigurePane) consome este
    endpoint em vez de duplicar a lógica de _build_prompt. Se a montagem
    do prompt mudar no backend, o preview acompanha sem ficar defasado.

    Não toca o banco (só monta strings do próprio payload), mas consome
    compute — exige autenticação para não ser endpoint aberto.
    """
    return PreviewPromptResponse(
        prompt=_build_prompt(req.project_description, req.prompt_template)
    )


@router.post("/cleanup-stale", response_model=CleanupResponse)
async def cleanup_stale(
    req: CleanupRequest,
    user: AuthUser = Depends(require_authenticated_user),
):
    """Marca runs com status='running' sem heartbeat recente como 'error'.

    Idempotente. Chamado pelo frontend antes de getRunningLlmJob para evitar
    que polling órfão (de uma run cuja máquina morreu) seja religado. Exige
    coordenador do projeto: o backend usa a service key (bypassa RLS), então
    a autorização é checada aqui, não no banco.
    """
    project_id = str(req.project_id)
    await run_in_threadpool(require_project_coordinator, project_id, user)
    n = mark_stale_runs_as_error(get_supabase(), project_id)
    return CleanupResponse(cleaned=n)
