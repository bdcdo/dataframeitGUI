"""
LLM runner service — coordinates dataframeit execution.

Security note: Uses exec() to compile coordinator-provided Pydantic models.
This is intentional — only authenticated coordinators can define schemas.
The backend runs in an isolated container.
"""
import hashlib
import logging
import random
import re
import time
import traceback
from collections import Counter
from datetime import datetime, timezone

import pandas as pd
from services.condition_evaluator import evaluate_condition, extract_field_conditions
from services.supabase_client import get_supabase
from services.pydantic_compiler import compile_pydantic, find_root_model

logger = logging.getLogger(__name__)

# In-memory job tracking
_jobs: dict[str, dict] = {}


def _status_from_row(row: dict) -> dict:
    """Shape a llm_runs row as a StatusResponse-compatible dict."""
    return {
        "status": row.get("status", "error"),
        "phase": row.get("phase", "error"),
        "progress": row.get("progress") or 0,
        "total": row.get("total") or 0,
        "errors": [row["error_message"]] if row.get("error_message") else [],
        "eta_seconds": None,
        "current_batch": 0,
        "total_batches": 0,
        "error_traceback": row.get("error_traceback"),
        "error_type": row.get("error_type"),
        "error_line": row.get("error_line"),
        "error_column": row.get("error_column"),
        "pydantic_code": row.get("pydantic_code"),
    }


def get_job_status(job_id: str) -> dict:
    if job_id in _jobs:
        return _jobs[job_id]
    # Fallback: job vanished from memory (container restart) but may exist in DB.
    try:
        sb = get_supabase()
        row = (
            sb.table("llm_runs")
            .select("status, phase, progress, total, error_message, error_type, "
                    "error_traceback, error_line, error_column, pydantic_code")
            .eq("job_id", job_id)
            .maybe_single()
            .execute()
            .data
        )
        if row:
            return _status_from_row(row)
    except Exception:
        logger.exception("Failed to fetch job status from llm_runs fallback")
    return {"status": "error", "phase": "error", "progress": 0, "total": 0,
            "errors": ["Job not found"], "eta_seconds": None,
            "current_batch": 0, "total_batches": 0}


def _extract_pydantic_location(exc: Exception, tb: str) -> tuple[int | None, int | None]:
    """Best-effort line/column inside pydantic_code where the error originated."""
    if isinstance(exc, SyntaxError) and exc.filename in (None, "<pydantic_schema>"):
        return exc.lineno, exc.offset
    m = re.search(r'File "<pydantic_schema>", line (\d+)', tb)
    if m:
        return int(m.group(1)), None
    return None, None


def _persist_run_insert(sb, job_id: str, project_id: str, filter_mode: str) -> None:
    """Insert the initial 'running' row as soon as the job starts."""
    try:
        sb.table("llm_runs").insert({
            "job_id": job_id,
            "project_id": project_id,
            "filter_mode": filter_mode,
            "status": "running",
            "phase": "loading",
        }).execute()
    except Exception:
        logger.exception("Failed to INSERT llm_runs row for job %s", job_id)


def _persist_run_snapshot(
    sb, job_id: str, project: dict, doc_count: int
) -> None:
    """Backfill provider/model/pydantic snapshot after the project is loaded."""
    try:
        sb.table("llm_runs").update({
            "llm_provider": project.get("llm_provider"),
            "llm_model": project.get("llm_model"),
            "document_count": doc_count,
            "pydantic_code": project.get("pydantic_code"),
        }).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs snapshot for job %s", job_id)


def _persist_run_completion(sb, job_id: str, progress: int, total: int) -> None:
    try:
        sb.table("llm_runs").update({
            "status": "completed",
            "phase": "completed",
            "progress": progress,
            "total": total,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs completion for job %s", job_id)


def _persist_run_error(sb, job_id: str, exc: Exception, tb: str) -> tuple[int | None, int | None]:
    line, col = _extract_pydantic_location(exc, tb)
    try:
        sb.table("llm_runs").update({
            "status": "error",
            "phase": "error",
            "error_message": str(exc),
            "error_type": type(exc).__name__,
            "error_traceback": tb,
            "error_line": line,
            "error_column": col,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs error for job %s", job_id)
    return line, col


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
    return find_root_model(namespace)


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
        "error_traceback": None, "error_type": None,
        "error_line": None, "error_column": None,
        "pydantic_code": None,
    }
    _persist_run_insert(sb, job_id, project_id, filter_mode)

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
        _jobs[job_id]["pydantic_code"] = pydantic_code
        _persist_run_snapshot(sb, job_id, project, len(docs))

        if not docs:
            _jobs[job_id]["status"] = "completed"
            _persist_run_completion(sb, job_id, 0, 0)
            return

        # Compile Pydantic model
        model_class = _compile_model(pydantic_code)
        if not model_class:
            raise RuntimeError("Nenhuma classe BaseModel encontrada no código Pydantic.")

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

        # Build per-field condition map once (same across all rows).
        # Fonte: pydantic_code compilado (regra CLAUDE.md "Pydantic = fonte
        # de verdade"). Nunca ler de projects.pydantic_fields aqui — a coluna
        # pode ficar defasada se o coordenador editar o código direto.
        field_conditions = extract_field_conditions(model_class)

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

            # Post-process conditional fields: remove values for fields whose
            # visibility condition is not satisfied by the sibling answers.
            # dataframeit core mode doesn't evaluate conditions itself, so the
            # LLM may have filled them even though Optional; we prune here to
            # keep the stored answers consistent with the researcher UX.
            if field_conditions:
                for field_name, condition in field_conditions.items():
                    if not evaluate_condition(condition, answers, field_name):
                        answers.pop(field_name, None)
                        justifications.pop(field_name, None)

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
        _persist_run_completion(
            sb, job_id, _jobs[job_id]["progress"], _jobs[job_id]["total"]
        )

    except Exception as e:
        tb = traceback.format_exc()
        line, col = _persist_run_error(sb, job_id, e, tb)
        _jobs[job_id]["status"] = "error"
        _jobs[job_id]["phase"] = "error"
        _jobs[job_id]["errors"].append(str(e))
        _jobs[job_id]["error_type"] = type(e).__name__
        _jobs[job_id]["error_traceback"] = tb
        _jobs[job_id]["error_line"] = line
        _jobs[job_id]["error_column"] = col
        logger.exception("LLM run %s failed", job_id)


async def run_llm_fields(
    job_id: str,
    project_id: str,
    field_names: list[str],
    document_ids: list[str] | None = None,
):
    """Re-run LLM only for specific fields."""
    await run_llm(job_id, project_id, document_ids)
