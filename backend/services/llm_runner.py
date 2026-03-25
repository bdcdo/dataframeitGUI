"""
LLM runner service — coordinates dataframeit execution.

Security note: Uses exec() to compile coordinator-provided Pydantic models.
This is intentional — only authenticated coordinators can define schemas.
The backend runs in an isolated container.
"""
import hashlib
import random
import time
from collections import Counter

import pandas as pd
from services.supabase_client import get_supabase
from services.pydantic_compiler import compile_pydantic

# In-memory job tracking
_jobs: dict[str, dict] = {}


def get_job_status(job_id: str) -> dict:
    if job_id not in _jobs:
        return {"status": "error", "phase": "error", "progress": 0, "total": 0,
                "errors": ["Job not found"], "eta_seconds": None,
                "current_batch": 0, "total_batches": 0}
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
    # noqa: S102 — intentional exec of coordinator-provided Pydantic code in isolated container
    exec(compiled_code, namespace)


def _build_prompt(
    project_description: str | None,
    prompt_template: str | None,
) -> str:
    """Assemble the final prompt from project metadata + additional instructions."""
    parts = [
        "Voce e um assistente de pesquisa especializado em analise de conteudo.",
        "Analise o documento fornecido e responda as perguntas de classificacao.",
        "",
        "## Instrucoes gerais",
        "- Leia o documento completo antes de classificar.",
        "- Baseie suas respostas exclusivamente no conteudo do documento.",
        "- Se houver ambiguidade, escolha a opcao mais conservadora.",
        "- Para campos de texto, seja conciso e objetivo.",
    ]

    if project_description and project_description.strip():
        parts.append("")
        parts.append("## Contexto do estudo")
        parts.append(project_description.strip())

    if prompt_template and prompt_template.strip():
        parts.append("")
        parts.append("## Instrucoes adicionais")
        parts.append(prompt_template.strip())

    return "\n".join(parts)


def _filter_docs(
    sb,
    docs: list[dict],
    project_id: str,
    filter_mode: str,
    max_response_count: int | None,
    sample_size: int | None,
) -> list[dict]:
    """Apply filtering to the document list based on filter_mode."""
    if filter_mode == "all":
        return docs

    if filter_mode in ("pending", "max_responses"):
        # Fetch current LLM responses to count per document
        existing = (
            sb.table("responses")
            .select("document_id")
            .eq("project_id", project_id)
            .eq("respondent_type", "llm")
            .eq("is_current", True)
            .execute()
            .data
        )
        counts = Counter(r["document_id"] for r in existing)

        if filter_mode == "pending":
            docs = [d for d in docs if counts.get(d["id"], 0) == 0]
        elif filter_mode == "max_responses" and max_response_count is not None:
            docs = [d for d in docs if counts.get(d["id"], 0) <= max_response_count]

    if filter_mode == "random_sample" and sample_size is not None:
        if len(docs) > sample_size:
            docs = random.sample(docs, sample_size)

    return docs


async def run_llm(
    job_id: str,
    project_id: str,
    document_ids: list[str] | None = None,
    filter_mode: str = "all",
    max_response_count: int | None = None,
    sample_size: int | None = None,
):
    """Run dataframeit on all (or filtered) documents."""
    sb = get_supabase()
    _jobs[job_id] = {
        "status": "running", "phase": "loading", "progress": 0, "total": 0,
        "errors": [], "started_at": time.time(), "eta_seconds": None,
        "current_batch": 0, "total_batches": 0,
    }

    try:
        # Load project (only needed columns)
        project = (
            sb.table("projects")
            .select("pydantic_code, prompt_template, llm_provider, llm_model, llm_kwargs, description, pydantic_fields")
            .eq("id", project_id)
            .single()
            .execute()
            .data
        )
        pydantic_code = project["pydantic_code"]
        prompt_template = _build_prompt(
            project.get("description"),
            project["prompt_template"],
        )
        llm_provider = project["llm_provider"]
        llm_model = project["llm_model"]
        llm_kwargs = project["llm_kwargs"] or {}
        pydantic_hash = hashlib.sha256(pydantic_code.encode()).hexdigest()[:16]

        # Build per-field hash snapshot for staleness detection
        answer_field_hashes = {
            f["name"]: f["hash"]
            for f in (project.get("pydantic_fields") or [])
            if f.get("hash")
        }

        # Load documents
        query = sb.table("documents").select("id, text, title, external_id").eq("project_id", project_id)
        if document_ids:
            query = query.in_("id", document_ids)
        docs = query.execute().data

        # Apply filtering
        docs = _filter_docs(sb, docs, project_id, filter_mode, max_response_count, sample_size)

        _jobs[job_id]["total"] = len(docs)

        if not docs:
            _jobs[job_id]["status"] = "completed"
            return

        # Compile Pydantic model
        model_class = _compile_model(pydantic_code)
        if not model_class:
            _jobs[job_id] = {"status": "error", "progress": 0, "total": 0, "errors": ["No BaseModel found"]}
            return

        # Optionally extend model with justification fields
        include_justifications = llm_kwargs.pop("include_justifications", False)
        if include_justifications:
            model_class = _extend_model_with_justifications(model_class)

        # Separate dataframeit params from model-specific params (temperature, thinking_level, etc.)
        parallel_requests = llm_kwargs.pop("parallel_requests", 5)
        rate_limit_delay = llm_kwargs.pop("rate_limit_delay", 0.5)

        DATAFRAMEIT_PARAMS = {
            "api_key", "max_retries", "base_delay", "max_delay", "track_tokens",
            "use_search", "search_provider", "search_per_field", "max_results",
            "search_depth", "search_groups", "save_trace", "resume",
            "reprocess_columns", "status_column",
        }
        model_kwargs = {k: v for k, v in llm_kwargs.items() if k not in DATAFRAMEIT_PARAMS}
        dfi_kwargs = {k: v for k, v in llm_kwargs.items() if k in DATAFRAMEIT_PARAMS}

        # Build DataFrame
        df = pd.DataFrame([{"id": d["id"], "texto": d["text"]} for d in docs])

        # Run dataframeit in batches for granular progress
        from dataframeit import dataframeit
        dfi_kwargs.pop("resume", None)

        batch_size = max(1, parallel_requests)
        batches = [df.iloc[i:i + batch_size] for i in range(0, len(df), batch_size)]
        _jobs[job_id].update(phase="processing", total_batches=len(batches))

        result_frames = []
        proc_start = time.time()
        for idx, batch_df in enumerate(batches):
            _jobs[job_id]["current_batch"] = idx + 1
            batch_result = dataframeit(
                batch_df,
                model_class,
                prompt_template,
                text_column="texto",
                provider=llm_provider,
                model=llm_model,
                parallel_requests=parallel_requests,
                rate_limit_delay=rate_limit_delay,
                model_kwargs=model_kwargs if model_kwargs else None,
                resume=False,
                **dfi_kwargs,
            )
            result_frames.append(batch_result)
            processed = sum(len(f) for f in result_frames)
            _jobs[job_id]["progress"] = processed
            elapsed = time.time() - proc_start
            if processed > 0:
                _jobs[job_id]["eta_seconds"] = round(
                    (elapsed / processed) * (len(df) - processed), 1
                )

        result_df = pd.concat(result_frames, ignore_index=True)

        # --- Saving phase ---
        _jobs[job_id].update(phase="saving", eta_seconds=None)

        # Mark all old LLM responses as not current in one batch
        doc_ids = [d["id"] for d in docs]
        sb.table("responses").update({"is_current": False}).eq(
            "project_id", project_id
        ).in_("document_id", doc_ids).eq("respondent_type", "llm").execute()

        # Save responses — use row["id"] (not index correlation) for safety
        for _, row in result_df.iterrows():
            doc_id = row["id"]
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

            sb.table("responses").insert({
                "project_id": project_id,
                "document_id": doc_id,
                "respondent_type": "llm",
                "respondent_name": f"{llm_provider}/{llm_model}",
                "answers": answers,
                "justifications": justifications if justifications else None,
                "is_current": True,
                "pydantic_hash": pydantic_hash,
                "answer_field_hashes": answer_field_hashes,
            }).execute()

        # Update project hash
        sb.table("projects").update({"pydantic_hash": pydantic_hash}).eq("id", project_id).execute()

        _jobs[job_id].update(status="completed", phase="completed", eta_seconds=0)

    except Exception as e:
        _jobs[job_id]["status"] = "error"
        _jobs[job_id]["phase"] = "error"
        _jobs[job_id]["errors"].append(str(e))


async def run_llm_fields(
    job_id: str,
    project_id: str,
    field_names: list[str],
    document_ids: list[str] | None = None,
):
    """Re-run LLM only for specific fields."""
    await run_llm(job_id, project_id, document_ids)
