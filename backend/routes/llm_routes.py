import uuid
from typing import Literal
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from services.llm_runner import init_job, run_llm, run_llm_fields, get_job_status

router = APIRouter()


class RunRequest(BaseModel):
    project_id: str
    document_ids: list[str] | None = None
    filter_mode: Literal["all", "pending", "max_responses", "random_sample"] = "all"
    max_response_count: int | None = None
    sample_size: int | None = None


class RunFieldRequest(BaseModel):
    project_id: str
    field_names: list[str]
    document_ids: list[str] | None = None


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
async def run(req: RunRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    # Síncrono: insere a row de llm_runs ANTES do background task. Se falhar
    # (RLS, conexão, payload), a request retorna 500 e o frontend mostra o erro
    # em vez de ficar com job fantasma que nunca aparece em Execuções.
    init_job(job_id, req.project_id, req.filter_mode)
    background_tasks.add_task(
        run_llm,
        job_id,
        req.project_id,
        req.document_ids,
        req.filter_mode,
        req.max_response_count,
        req.sample_size,
    )
    return {"job_id": job_id}


@router.post("/run-field", response_model=RunResponse)
async def run_field(req: RunFieldRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    # filter_mode "all" porque run-field não tem semântica de subset; o
    # subset é o conjunto de fields, não de docs.
    init_job(job_id, req.project_id, "all")
    background_tasks.add_task(
        run_llm_fields, job_id, req.project_id, req.field_names, req.document_ids
    )
    return {"job_id": job_id}


@router.get("/status/{job_id}", response_model=StatusResponse)
async def status(job_id: str):
    return get_job_status(job_id)
