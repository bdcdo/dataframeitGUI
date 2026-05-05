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
from datetime import datetime, timedelta, timezone

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
        # Counters persistidos em llm_runs pelo save loop (ver
        # _persist_run_progress). No fallback de container reiniciado, ainda
        # mostram o ultimo snapshot conhecido — antes desta migration ficavam
        # zerados, o que mascarava o trabalho ja feito.
        "processed_complete": row.get("processed_complete") or 0,
        "processed_partial": row.get("processed_partial") or 0,
        "processed_empty": row.get("processed_empty") or 0,
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
                    "error_traceback, error_line, error_column, pydantic_code, "
                    "processed_complete, processed_partial, processed_empty")
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
            "current_batch": 0, "total_batches": 0,
            "processed_complete": 0, "processed_partial": 0, "processed_empty": 0}


def _extract_pydantic_location(exc: Exception, tb: str) -> tuple[int | None, int | None]:
    """Best-effort line/column inside pydantic_code where the error originated."""
    if isinstance(exc, SyntaxError) and exc.filename in (None, "<pydantic_schema>"):
        return exc.lineno, exc.offset
    m = re.search(r'File "<pydantic_schema>", line (\d+)', tb)
    if m:
        return int(m.group(1)), None
    return None, None


def _persist_run_insert(sb, job_id: str, project_id: str, filter_mode: str) -> None:
    """Insert the initial 'running' row as soon as the job starts.

    Re-raise on failure: se o INSERT em llm_runs morrer silenciosamente, a run
    fica órfã (executa em memória mas não aparece na aba Execuções), o que já
    enganou o usuário no passado. Melhor falhar a request do /run e mostrar o
    erro de cara em vez de seguir uma execução invisível.
    """
    sb.table("llm_runs").insert({
        "job_id": job_id,
        "project_id": project_id,
        "filter_mode": filter_mode,
        "status": "running",
        "phase": "loading",
        # heartbeat inicial. O save loop renova a cada ~2s (ver
        # _persist_run_progress); cleanup ativo (mark_stale_runs_as_error)
        # marca como erro runs cujo heartbeat ficou velho.
        "heartbeat_at": datetime.now(timezone.utc).isoformat(),
    }).execute()


def _persist_run_progress(sb, job_id: str, jobs_state: dict) -> None:
    """Persistir snapshot de counters + heartbeat em llm_runs.

    Chamado periodicamente pelo save loop (throttle 2s). Erros aqui são
    logados, não re-lançados: a run principal não deve abortar só porque uma
    atualização de progresso falhou. O próximo tick tenta de novo.
    """
    try:
        sb.table("llm_runs").update({
            "processed_complete": jobs_state.get("processed_complete", 0),
            "processed_partial": jobs_state.get("processed_partial", 0),
            "processed_empty": jobs_state.get("processed_empty", 0),
            "progress": jobs_state.get("progress", 0),
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
        }).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs progress for job %s", job_id)


def mark_stale_runs_as_error(sb, project_id: str) -> int:
    """Marcar como 'error' runs órfãs do projeto (sem heartbeat recente).

    Critério: status='running' e (heartbeat antigo OR heartbeat null com
    started_at antigo). O segundo caso cobre runs criadas antes desta
    migration que nunca terão heartbeat.

    Retorna o número de runs marcadas como erro. Idempotente.
    """
    now = datetime.now(timezone.utc)
    # 5 minutos sem heartbeat = morta. O save loop renova a cada ~2s, então
    # 5min é folgado o suficiente para evitar falsos positivos em pausas
    # legítimas (ex.: GC do Python, latência do Supabase). 30min para runs
    # sem heartbeat (pré-migration) — conservador.
    heartbeat_cutoff_iso = (now - timedelta(minutes=5)).isoformat()
    started_cutoff_iso = (now - timedelta(minutes=30)).isoformat()

    error_msg = (
        "Execução abandonada (sem heartbeat — possivelmente o backend "
        "reiniciou ou a máquina hibernou)."
    )
    # PostgREST .or_ syntax: separa termos por vírgula; agrupa com and(...).
    or_clause = (
        f"heartbeat_at.lt.{heartbeat_cutoff_iso},"
        f"and(heartbeat_at.is.null,started_at.lt.{started_cutoff_iso})"
    )
    res = (
        sb.table("llm_runs")
        .update({
            "status": "error",
            "phase": "error",
            "error_message": error_msg,
            "completed_at": now.isoformat(),
        })
        .eq("project_id", project_id)
        .eq("status", "running")
        .or_(or_clause)
        .execute()
    )
    return len(res.data or [])


def _persist_run_snapshot(
    sb, job_id: str, project: dict, doc_count: int
) -> None:
    """Backfill provider/model/pydantic snapshot after the project is loaded.

    Não engolir erro: se essa atualização falhar, a aba Execuções fica sem
    metadados da run e o usuário não consegue diagnosticar nada depois.
    """
    sb.table("llm_runs").update({
        "llm_provider": project.get("llm_provider"),
        "llm_model": project.get("llm_model"),
        "document_count": doc_count,
        "pydantic_code": project.get("pydantic_code"),
    }).eq("job_id", job_id).execute()


def _persist_run_completion(
    sb,
    job_id: str,
    progress: int,
    total: int,
    warnings: list[str] | None = None,
    counters: dict | None = None,
) -> None:
    """Mark the run as completed. Errors here are logged but do not re-raise.

    Diferente de _persist_run_insert/_snapshot: aqui a execução já terminou e o
    payload já está em responses. Ressuscitar a exception levaria a `_persist_run_error`
    em cascata e duplicaria o registro de falha. Logar é suficiente.

    `counters` recebe dict com processed_complete/partial/empty para fechar
    o snapshot final consistente — sem isso, o último update via
    _persist_run_progress poderia ter ficado desatualizado em até 2s.
    """
    try:
        payload: dict = {
            "status": "completed",
            "phase": "completed",
            "progress": progress,
            "total": total,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if counters:
            payload["processed_complete"] = counters.get("processed_complete", 0)
            payload["processed_partial"] = counters.get("processed_partial", 0)
            payload["processed_empty"] = counters.get("processed_empty", 0)
        # Persistir warnings de cobertura parcial reutilizando error_message
        # (evita migration). Motivo: llm_runs.error_message é o único campo
        # livre para texto diagnóstico pós-completion.
        if warnings:
            payload["error_message"] = "Warnings ({} doc(s)): {}".format(
                len(warnings), " | ".join(warnings[:20])
            )
        sb.table("llm_runs").update(payload).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs completion for job %s", job_id)


def _persist_run_error(
    sb, job_id: str, exc: Exception, tb: str, counters: dict | None = None
) -> tuple[int | None, int | None]:
    line, col = _extract_pydantic_location(exc, tb)
    try:
        payload: dict = {
            "status": "error",
            "phase": "error",
            "error_message": str(exc),
            "error_type": type(exc).__name__,
            "error_traceback": tb,
            "error_line": line,
            "error_column": col,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if counters:
            payload["processed_complete"] = counters.get("processed_complete", 0)
            payload["processed_partial"] = counters.get("processed_partial", 0)
            payload["processed_empty"] = counters.get("processed_empty", 0)
        sb.table("llm_runs").update(payload).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs error for job %s", job_id)
    return line, col


def _answers_have_content(answers: dict) -> bool:
    """True se algum field tem valor significativo. Espelha
    LlmResponseRow.classifyResponse no frontend para counters consistentes.
    """
    for v in answers.values():
        if v is None:
            continue
        if isinstance(v, str):
            if v.strip():
                return True
        elif isinstance(v, list):
            if v:
                return True
        elif isinstance(v, dict):
            if v:
                return True
        else:
            return True
    return False


def _is_nan(val) -> bool:
    """True se val for um float NaN. Outros tipos não são considerados NaN.

    Necessário porque dataframeit deixa np.nan em rows com erro, e bool(NaN)
    é True em Python — sem essa guarda, NaN passaria como "preenchido".
    """
    return isinstance(val, float) and pd.isna(val)


def _extract_answers_from_row(row, model_class) -> tuple[dict, dict]:
    """Extrai answers e justifications de uma row do result_df.

    Itera sobre `model_class.model_fields` (não sobre as colunas da row) para
    descartar colunas internas do dataframeit (`_dataframeit_status`,
    `_error_details`) e qualquer extra que o provider tenha incluído.

    Filtra NaN explicitamente — sem isso, rows que dataframeit marcou como
    erro (que vêm com NaN nos campos) entrariam em `answers` como "preenchido".
    """
    answers: dict = {}
    justifications: dict = {}

    for field_name in model_class.model_fields:
        val = row.get(field_name)
        if val is not None and not _is_nan(val):
            if isinstance(val, list):
                answers[field_name] = val
            else:
                answers[field_name] = str(val)

        just_col = f"{field_name}_justification"
        # `just_col in row` aceita tanto dict quanto pandas.Series; truthy
        # check em conjunto com _is_nan cobre None, "", e NaN.
        if just_col in row:
            jval = row[just_col]
            if jval and not _is_nan(jval):
                justifications[field_name] = str(jval)

    return answers, justifications


def _build_llm_error_message(
    *,
    dfi_error: str | None,
    is_empty: bool,
    is_partial: bool,
    dfi_status,
    pre_prune_keys: list[str],
    post_prune_keys: list[str],
    answered_count: int,
    active_expected_count: int,
) -> str | None:
    """Monta a mensagem para responses.llm_error a partir do diagnóstico.

    Hierarquia (ordem importa):
    1. Erro cru do dataframeit (timeout, parse, structured-output null)
    2. answers vazio após prune (LLM trouxe os campos mas evaluate_condition
       zerou) ou LLM trouxe vazio direto
    3. Cobertura baixa (LLM já chega com poucos campos)
    Retorna None quando a resposta está saudável.
    """
    if dfi_error:
        return f"dataframeit: {dfi_error}"
    if is_empty:
        return (
            f"answers vazio após prune; pre_prune_keys={pre_prune_keys}; "
            f"dfi_status={dfi_status}"
        )
    if is_partial:
        return (
            f"cobertura baixa ({answered_count}/{active_expected_count}); "
            f"pre_prune_keys={pre_prune_keys}; "
            f"post_prune_keys={post_prune_keys}"
        )
    return None


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


# Separador usado para achatar nested BaseModels em top-level (ver
# _flatten_nested_basemodels abaixo). Dois underscores minimizam colisão com
# nomes de campo reais (q2_id_..., q24a_...).
_NESTED_FLATTEN_SEP = "__"


def _flatten_nested_basemodels(model_class):
    """Expande fields cujo tipo é um BaseModel em campos top-level.

    Motivação: alguns providers (Gemini em especial) achatam silenciosamente
    subfields de BaseModel aninhado no topo do JSON de saída. Como os
    subfields desses modelos costumam ter defaults (Optional[str]=None),
    o Pydantic aceita o dict vazio para o BaseModel pai sem erro, e a
    resposta é persistida com quase nenhum campo real. Achatar antes de
    enviar ao LLM elimina essa classe de falha silenciosa.

    Retorna (FlatModel, field_map) onde field_map[original_name] é uma
    lista de (flat_name, sub_name) usada para reconstruir o dict aninhado
    após o parse. Quando nenhum field é BaseModel, retorna o próprio
    model_class com field_map vazio.
    """
    from pydantic import BaseModel, create_model

    flat_fields: dict = {}
    field_map: dict[str, list[tuple[str, str]]] = {}

    for name, info in model_class.model_fields.items():
        ann = info.annotation
        if (
            isinstance(ann, type)
            and issubclass(ann, BaseModel)
            and ann is not BaseModel
        ):
            field_map[name] = []
            for sub_name, sub_info in ann.model_fields.items():
                flat_name = f"{name}{_NESTED_FLATTEN_SEP}{sub_name}"
                flat_fields[flat_name] = (sub_info.annotation, sub_info)
                field_map[name].append((flat_name, sub_name))
        else:
            flat_fields[name] = (info.annotation, info)

    if not field_map:
        return model_class, field_map

    flat_model = create_model(
        f"{model_class.__name__}Flat",
        __base__=BaseModel,
        **flat_fields,
    )
    return flat_model, field_map


def _filter_model_for_llm(model_class, pydantic_fields: list[dict]):
    """Return a model class excluding fields that should not be sent to the LLM.

    A field is excluded when its ``target`` in ``pydantic_fields`` is either
    ``"none"`` (hidden from everyone) or ``"human_only"``. Returns the original
    ``model_class`` unchanged when no fields need to be excluded.

    Note: the filtered model is created with ``__base__=BaseModel``, so any
    custom ``model_config`` or validators on the original class are not
    preserved. This is acceptable because ``dataframeit`` only inspects the
    schema (fields + annotations). If custom validators become relevant,
    switch to ``__base__=model_class`` and drop excluded fields differently.
    """
    from pydantic import BaseModel, create_model

    excluded_names = {
        f["name"]
        for f in (pydantic_fields or [])
        if f.get("target") in ("none", "human_only")
    }
    if not excluded_names:
        return model_class

    kept: dict = {}
    for name, info in model_class.model_fields.items():
        if name in excluded_names:
            continue
        kept[name] = (info.annotation, info)

    return create_model(
        f"{model_class.__name__}ForLLM",
        __base__=BaseModel,
        **kept,
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


def init_job(job_id: str, project_id: str, filter_mode: str) -> None:
    """Inicializar estado do job + INSERT em llm_runs.

    Chamado sincronamente pelo endpoint /run antes do background task. Se
    o INSERT falhar (RLS, conexão, payload malformado), a exceção sobe pro
    handler do FastAPI e o usuário vê 500 em vez de uma run fantasma que
    nunca aparece em Execuções.
    """
    sb = get_supabase()
    _jobs[job_id] = {
        "status": "running", "phase": "loading", "progress": 0, "total": 0,
        "errors": [], "started_at": time.time(), "eta_seconds": None,
        "current_batch": 0, "total_batches": 0,
        "error_traceback": None, "error_type": None,
        "error_line": None, "error_column": None,
        "pydantic_code": None,
        # Counters atualizados durante a fase de saving para o frontend
        # mostrar feedback ao vivo de quantos documentos saíram completos /
        # parciais / vazios (ver LlmConfigurePane). Classificação espelha
        # LlmResponseRow.classifyResponse no frontend.
        "processed_complete": 0,
        "processed_partial": 0,
        "processed_empty": 0,
        # Throttle do _persist_run_progress (atualiza a cada 2s).
        "last_progress_persist": 0.0,
    }
    _persist_run_insert(sb, job_id, project_id, filter_mode)


async def run_llm(
    job_id: str,
    project_id: str,
    document_ids: list[str] | None = None,
    filter_mode: str = "all",
    max_response_count: int | None = None,
    sample_size: int | None = None,
):
    """Run dataframeit on all (or filtered) documents.

    Pré-condição: init_job(job_id, project_id, filter_mode) já foi chamado
    pelo handler do /run. Aqui já assumimos _jobs[job_id] populado e
    llm_runs row existente.
    """
    sb = get_supabase()

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

        # Filter out fields that should not be sent to the LLM
        # (target="none" hides from everyone; target="human_only" hides from LLM)
        model_class = _filter_model_for_llm(
            model_class, project.get("pydantic_fields") or []
        )

        # Achatar nested BaseModels em top-level ANTES do extend. Evita o
        # padrão em que o provider (Gemini) retorna os subfields flat e o
        # Pydantic aceita o dict vazio para o BaseModel pai, produzindo
        # resposta quase sem dados. field_map é usado no save loop para
        # reconstruir o formato aninhado ao persistir em responses.answers.
        model_class, nested_field_map = _flatten_nested_basemodels(model_class)

        # Optionally extend model with justification fields
        include_justifications = llm_kwargs.pop("include_justifications", False)
        if include_justifications:
            model_class = _extend_model_with_justifications(model_class)

        # Separate dataframeit params from model-specific params (temperature, thinking_level, etc.)
        parallel_requests = llm_kwargs.pop("parallel_requests", 5)
        rate_limit_delay = llm_kwargs.pop("rate_limit_delay", 0.5)

        # Thresholds configuráveis por projeto para detecção de respostas
        # parciais. Valores fora de [0, 1] caem para o default. São popados
        # de llm_kwargs para não vazarem para o LLM / dataframeit.
        def _threshold(key: str, default: float) -> float:
            raw = llm_kwargs.pop(key, None)
            if raw is None:
                return default
            try:
                v = float(raw)
            except (TypeError, ValueError):
                logger.warning(
                    "llm_kwargs['%s']=%r não é número, usando default %s",
                    key, raw, default,
                )
                return default
            if not 0 <= v <= 1:
                logger.warning(
                    "llm_kwargs['%s']=%s fora de [0,1], usando default %s",
                    key, v, default,
                )
                return default
            return v

        partial_coverage_threshold = _threshold("partial_coverage_threshold", 0.5)
        run_failure_threshold = _threshold("run_failure_threshold", 0.3)

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
        # Throttle de heartbeat na fase de processing. Importante porque
        # processar pode levar minutos antes do save loop começar; sem
        # heartbeat aqui, mark_stale_runs_as_error marcaria a run como morta
        # mesmo estando viva.
        last_proc_heartbeat = 0.0
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
            now_ts = time.time()
            if now_ts - last_proc_heartbeat >= 2.0:
                _persist_run_progress(sb, job_id, _jobs[job_id])
                last_proc_heartbeat = now_ts

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

        # Set dos campos top-level que esperamos ver preenchidos em
        # responses.answers após reconstrução. Subfields flat (foo__bar)
        # contam pelo seu parent (foo), pois o que importa para detecção de
        # parcial é se o conceito de alto nível ficou representado.
        expected_llm_fields = set()
        for name in model_class.model_fields:
            if name.endswith("_justification"):
                continue
            if _NESTED_FLATTEN_SEP in name:
                expected_llm_fields.add(name.split(_NESTED_FLATTEN_SEP, 1)[0])
            else:
                expected_llm_fields.add(name)

        partial_warnings: list[str] = []
        # Sample de _error_details reais por mensagem para incluir no
        # RuntimeError quando a run for marcada como comprometida. Mais útil
        # do que só "cobertura baixa" porque diz a causa. Chave: hash MD5 da
        # mensagem completa, evita agrupar erros distintos com prefixo igual.
        dfi_error_samples: dict[str, str] = {}

        # Throttle do persist de progresso para llm_runs. Atualizar a cada row
        # dobraria a load (já há 1 INSERT em responses por row); 2s mantém
        # heartbeat fresco e counters próximos do real-time sem custo dobrado.
        # last_progress_persist é inicializado em init_job.
        progress_persist_interval_s = 2.0

        # Save responses — use row["id"] (not index correlation) for safety
        for _, row in result_df.iterrows():
            doc_id = row["id"]

            # Diagnóstico cru do dataframeit (ver dataframeit/core.py:451-452):
            # _dataframeit_status é 'processed' ou 'error'; _error_details traz
            # a mensagem da exceção quando a row falhou. Sem ler isso, qualquer
            # falha de provider/parse/timeout vira "resposta vazia" sem motivo.
            dfi_status = row.get("_dataframeit_status")
            dfi_error_raw = row.get("_error_details")
            dfi_error: str | None = (
                str(dfi_error_raw) if dfi_error_raw is not None and pd.notna(dfi_error_raw) else None
            )

            answers, justifications = _extract_answers_from_row(row, model_class)

            # Reconstruir dicts aninhados a partir dos subfields flat (ver
            # _flatten_nested_basemodels). Deve rodar ANTES do prune de
            # condicionais para que condições que referenciam o field pai
            # (ex.: q21 em q24a) continuem sendo avaliadas sobre o shape
            # original que a UI / humanas usam. Justifications de subfields
            # são concatenadas em string para manter Record<string,string>
            # esperado pelo frontend.
            for original_name, subs in nested_field_map.items():
                sub_dict: dict = {}
                sub_justs: dict = {}
                for flat_name, sub_name in subs:
                    if flat_name in answers:
                        sub_dict[sub_name] = answers.pop(flat_name)
                    if flat_name in justifications:
                        sub_justs[sub_name] = justifications.pop(flat_name)
                if sub_dict:
                    answers[original_name] = sub_dict
                if sub_justs:
                    justifications[original_name] = "\n".join(
                        f"{k}: {v}" for k, v in sub_justs.items()
                    )

            # Snapshot pré-prune para diagnosticar quando o evaluate_condition
            # zera campos. Se uma resposta sai com 1 campo só mas pre_prune
            # tinha muitos, o problema está nas conditions — não no LLM.
            answers_pre_prune_keys = sorted(answers.keys())

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

            # Detectar respostas parciais: campos esperados cuja condition
            # está satisfeita mas que não vieram do LLM. Excluímos condicionais
            # não-satisfeitas porque ausência delas é legítima.
            active_expected = {
                name for name in expected_llm_fields
                if name not in field_conditions
                or evaluate_condition(field_conditions[name], answers, name)
            }
            answered = set(answers.keys()) & active_expected
            coverage = len(answered) / len(active_expected) if active_expected else 1.0
            is_partial = coverage < partial_coverage_threshold

            # Classificação para counters ao vivo. Espelha
            # LlmResponseRow.classifyResponse no frontend: vazia se nenhum
            # field tem conteúdo significativo; senão complete ou partial.
            is_empty = not _answers_have_content(answers)
            if is_empty:
                _jobs[job_id]["processed_empty"] += 1
            elif is_partial:
                _jobs[job_id]["processed_partial"] += 1
            else:
                _jobs[job_id]["processed_complete"] += 1

            llm_error_msg = _build_llm_error_message(
                dfi_error=dfi_error,
                is_empty=is_empty,
                is_partial=is_partial,
                dfi_status=dfi_status,
                pre_prune_keys=answers_pre_prune_keys,
                post_prune_keys=sorted(answers.keys()),
                answered_count=len(answered),
                active_expected_count=len(active_expected),
            )

            if is_partial or is_empty or dfi_error:
                logger.warning(
                    "LLM row diag doc=%s status=%s error=%s pre_prune=%s post_prune=%s",
                    doc_id, dfi_status, dfi_error,
                    answers_pre_prune_keys, sorted(answers.keys()),
                )

            if dfi_error:
                # Agrupa por hash da mensagem (não prefixo) para o RuntimeError
                # final. Truncar 120 chars agrupava erros distintos com prefixo
                # igual.
                key = hashlib.md5(
                    dfi_error.encode("utf-8", errors="replace")
                ).hexdigest()[:16]
                if key not in dfi_error_samples:
                    dfi_error_samples[key] = f"doc={doc_id}: {dfi_error}"

            if is_partial:
                missing = sorted(active_expected - answered)
                warning_msg = (
                    f"doc={doc_id}: cobertura baixa "
                    f"({len(answered)}/{len(active_expected)}); "
                    f"faltaram: {missing[:8]}{'...' if len(missing) > 8 else ''}"
                )
                partial_warnings.append(warning_msg)
                _jobs[job_id].setdefault("warnings", []).append(warning_msg)

            # Throttle: persiste counters + heartbeat a cada 2s. Garante que
            # mesmo após scale-to-zero o llm_runs reflete o trabalho feito,
            # e que a UI consegue distinguir run viva de zumbi.
            now_ts = time.time()
            if now_ts - _jobs[job_id]["last_progress_persist"] >= progress_persist_interval_s:
                _persist_run_progress(sb, job_id, _jobs[job_id])
                _jobs[job_id]["last_progress_persist"] = now_ts

            sb.table("responses").insert({
                "project_id": project_id,
                "document_id": doc_id,
                "respondent_type": "llm",
                "respondent_name": f"{llm_provider}/{llm_model}",
                "answers": answers,
                "justifications": justifications if justifications else None,
                # is_current: respostas parciais já nascem como False para não
                # poluírem Comparar (ver PR #65). Uma run posterior sobre os
                # mesmos docs também vai marcar esta resposta como False via
                # bulk update logo acima.
                "is_current": not is_partial,
                # is_partial: imutável após o insert. Preserva o classificador
                # "cobertura baixa" mesmo depois que uma run posterior supersede
                # esta resposta (ver migration 20260425000000).
                "is_partial": is_partial,
                "pydantic_hash": pydantic_hash,
                "answer_field_hashes": answer_field_hashes,
                # Correlaciona a resposta com a execução que a produziu para a
                # aba LLM > Respostas (ver migration 20260424000000).
                "llm_job_id": job_id,
                # Diagnóstico por documento (ver migration 20260504000002).
                # Null quando a resposta é saudável; senão traz o motivo real
                # (erro do dataframeit, prune zerou, ou cobertura baixa).
                "llm_error": llm_error_msg,
            }).execute()

        # Update project hash
        sb.table("projects").update({"pydantic_hash": pydantic_hash}).eq("id", project_id).execute()

        # Check de run comprometida: se uma fração grande dos docs produziu
        # resposta parcial, a run é marcada como erro para ficar visível na UI
        # em vez de passar como "completed" com warnings enterrados.
        total_processed = len(result_df)
        partial_ratio = (
            len(partial_warnings) / total_processed if total_processed else 0.0
        )
        if partial_ratio >= run_failure_threshold:
            # Inclui exemplos de _error_details reais (quando dataframeit
            # falhou) além dos warnings de cobertura. Mais útil que só
            # "cobertura baixa" porque diz a causa primária.
            error_examples = list(dfi_error_samples.values())[:3]
            sections = [
                f"Run comprometida: {len(partial_warnings)}/{total_processed} "
                f"docs ({int(partial_ratio * 100)}%) com resposta parcial. "
                f"Respostas gravadas com is_current=false."
            ]
            if error_examples:
                sections.append(
                    "Erros do provider: " + " || ".join(error_examples)
                )
            sections.append(
                "Exemplos de cobertura baixa: " + " || ".join(partial_warnings[:3])
            )
            raise RuntimeError(" ".join(sections))

        _jobs[job_id].update(status="completed", phase="completed", eta_seconds=0)
        _persist_run_completion(
            sb,
            job_id,
            _jobs[job_id]["progress"],
            _jobs[job_id]["total"],
            warnings=partial_warnings or None,
            counters=_jobs[job_id],
        )

    except Exception as e:
        tb = traceback.format_exc()
        # Passa counters do _jobs para fechar snapshot consistente em llm_runs
        # mesmo quando a run falha mid-loop. Sem isso, o último _persist_run_progress
        # poderia ter ficado até 2s atrás.
        counters = _jobs.get(job_id) or {}
        line, col = _persist_run_error(sb, job_id, e, tb, counters=counters)
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
