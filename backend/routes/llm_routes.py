import uuid
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from services.llm_runner import run_llm, run_llm_fields, get_job_status

router = APIRouter()


class RunRequest(BaseModel):
    project_id: str
    document_ids: list[str] | None = None


class RunFieldRequest(BaseModel):
    project_id: str
    field_names: list[str]
    document_ids: list[str] | None = None


class RunResponse(BaseModel):
    job_id: str


class StatusResponse(BaseModel):
    status: str
    progress: int
    total: int
    errors: list[str]


@router.post("/run", response_model=RunResponse)
async def run(req: RunRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    background_tasks.add_task(run_llm, job_id, req.project_id, req.document_ids)
    return {"job_id": job_id}


@router.post("/run-field", response_model=RunResponse)
async def run_field(req: RunFieldRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    background_tasks.add_task(
        run_llm_fields, job_id, req.project_id, req.field_names, req.document_ids
    )
    return {"job_id": job_id}


@router.get("/status/{job_id}", response_model=StatusResponse)
async def status(job_id: str):
    return get_job_status(job_id)
