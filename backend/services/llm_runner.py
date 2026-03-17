"""
LLM runner service — coordinates dataframeit execution.

Security note: Uses exec() to compile coordinator-provided Pydantic models.
This is intentional — only authenticated coordinators can define schemas.
The backend runs in an isolated container.
"""
import hashlib
import pandas as pd
from services.supabase_client import get_supabase
from services.pydantic_compiler import compile_pydantic

# In-memory job tracking
_jobs: dict[str, dict] = {}


def get_job_status(job_id: str) -> dict:
    if job_id not in _jobs:
        return {"status": "error", "progress": 0, "total": 0, "errors": ["Job not found"]}
    return _jobs[job_id]


def _extend_model_with_justifications(model_class):
    """Add a justification field for each existing field in the model."""
    from pydantic import BaseModel, Field, create_model

    extra_fields = {}
    for name in model_class.model_fields:
        just_name = f"{name}_justification"
        extra_fields[just_name] = (
            str,
            Field(description=f"Justificativa detalhada para a resposta de '{name}'"),
        )
    return create_model(
        f"{model_class.__name__}WithJustifications",
        __base__=model_class,
        **extra_fields,
    )


def _compile_model(pydantic_code: str):
    """Compile Pydantic code and return the model class."""
    namespace: dict = {}
    compiled = compile(pydantic_code, "<pydantic_schema>", "exec")  # noqa: S102
    _run_compiled(compiled, namespace)

    from pydantic import BaseModel
    for obj in namespace.values():
        if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel:
            return obj
    return None


def _run_compiled(compiled_code: object, namespace: dict) -> None:
    """Execute pre-compiled code. Separated for clarity."""
    exec(compiled_code, namespace)  # noqa: S102


async def run_llm(
    job_id: str, project_id: str, document_ids: list[str] | None = None
):
    """Run dataframeit on all (or specified) documents."""
    sb = get_supabase()
    _jobs[job_id] = {"status": "running", "progress": 0, "total": 0, "errors": []}

    try:
        # Load project
        project = sb.table("projects").select("*").eq("id", project_id).single().execute().data
        pydantic_code = project["pydantic_code"]
        prompt_template = project["prompt_template"]
        llm_provider = project["llm_provider"]
        llm_model = project["llm_model"]
        llm_kwargs = project["llm_kwargs"] or {}
        pydantic_hash = hashlib.sha256(pydantic_code.encode()).hexdigest()[:16]

        # Load documents
        query = sb.table("documents").select("id, text, title, external_id").eq("project_id", project_id)
        if document_ids:
            query = query.in_("id", document_ids)
        docs = query.execute().data

        _jobs[job_id]["total"] = len(docs)

        # Compile Pydantic model
        model_class = _compile_model(pydantic_code)
        if not model_class:
            _jobs[job_id] = {"status": "error", "progress": 0, "total": 0, "errors": ["No BaseModel found"]}
            return

        # Optionally extend model with justification fields
        include_justifications = llm_kwargs.pop("include_justifications", False)
        if include_justifications:
            model_class = _extend_model_with_justifications(model_class)

        # Build DataFrame
        df = pd.DataFrame([{"id": d["id"], "texto": d["text"]} for d in docs])

        # Run dataframeit
        from dataframeit import dataframeit
        result_df = dataframeit(
            df,
            model_class,
            prompt_template,
            text_column="texto",
            provider=llm_provider,
            model=llm_model,
            parallel_requests=llm_kwargs.pop("parallel_requests", 5),
            rate_limit_delay=llm_kwargs.pop("rate_limit_delay", 0.5),
            **llm_kwargs,
        )

        # Save responses
        for i, (_, row) in enumerate(result_df.iterrows()):
            doc_id = docs[i]["id"]
            answers = {}
            justifications = {}

            for field_name in model_class.model_fields:
                val = row.get(field_name)
                if val is not None:
                    if isinstance(val, list):
                        answers[field_name] = val
                    else:
                        answers[field_name] = str(val)

                just_col = f"{field_name}_justification"
                if just_col in row and row[just_col]:
                    justifications[field_name] = str(row[just_col])

            # Mark old LLM responses as not current
            sb.table("responses").update({"is_current": False}).eq(
                "project_id", project_id
            ).eq("document_id", doc_id).eq("respondent_type", "llm").execute()

            # Insert new response
            sb.table("responses").insert({
                "project_id": project_id,
                "document_id": doc_id,
                "respondent_type": "llm",
                "respondent_name": f"{llm_provider}/{llm_model}",
                "answers": answers,
                "justifications": justifications if justifications else None,
                "is_current": True,
                "pydantic_hash": pydantic_hash,
            }).execute()

            _jobs[job_id]["progress"] = i + 1

        # Update project hash
        sb.table("projects").update({"pydantic_hash": pydantic_hash}).eq("id", project_id).execute()

        _jobs[job_id]["status"] = "completed"

    except Exception as e:
        _jobs[job_id]["status"] = "error"
        _jobs[job_id]["errors"].append(str(e))


async def run_llm_fields(
    job_id: str,
    project_id: str,
    field_names: list[str],
    document_ids: list[str] | None = None,
):
    """Re-run LLM only for specific fields."""
    await run_llm(job_id, project_id, document_ids)
