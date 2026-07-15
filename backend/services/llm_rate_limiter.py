"""Distributed rate limit for paid LLM dispatch endpoints."""

import logging
from dataclasses import dataclass
from typing import Any, cast

from fastapi import HTTPException

from config import settings
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int


def _parse_decision(data: object) -> RateLimitDecision:
    if not isinstance(data, list) or len(data) != 1:
        raise ValueError("consume_llm_rate_limit must return exactly one row")
    row = cast(dict[str, Any], data[0])
    if not isinstance(row, dict):
        raise ValueError("consume_llm_rate_limit returned a non-object row")

    allowed = row.get("allowed")
    retry_after = row.get("retry_after_seconds")
    if allowed.__class__ is not bool or retry_after.__class__ is not int:
        raise ValueError("consume_llm_rate_limit returned an invalid row shape")
    if retry_after < 1:
        raise ValueError("consume_llm_rate_limit returned an invalid retry interval")
    return RateLimitDecision(allowed=allowed, retry_after_seconds=retry_after)


def enforce_llm_rate_limit(project_id: str, user_id: str) -> None:
    """Consume one shared LLM dispatch token or reject the request.

    The database function resolves project-scoped aliases to the canonical
    member identity before locking the bucket. Any database or contract failure
    rejects the dispatch before ``init_job`` so paid work never starts while the
    limiter state is unknown.
    """

    try:
        response = (
            get_supabase()
            .rpc(
                "consume_llm_rate_limit",
                {
                    "p_user_id": user_id,
                    "p_project_id": project_id,
                    "p_limit": settings.llm_rate_limit_requests,
                    "p_window_seconds": settings.llm_rate_limit_window_seconds,
                },
            )
            .execute()
        )
        decision = _parse_decision(response.data)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Falha ao consumir rate limit de LLM (project_id=%s, user_id=%s)",
            project_id,
            user_id,
        )
        raise HTTPException(
            status_code=503,
            detail="Não foi possível verificar o limite de execuções LLM",
        ) from exc

    if not decision.allowed:
        retry_after = str(decision.retry_after_seconds)
        raise HTTPException(
            status_code=429,
            detail=(
                "Limite de execuções LLM atingido; tente novamente em "
                f"{retry_after} segundos"
            ),
            headers={"Retry-After": retry_after},
        )
