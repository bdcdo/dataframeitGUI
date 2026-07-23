"""Best-effort wakeups for the durable auto-review reconciliation outbox."""

import asyncio
import logging

import httpx

from config import settings
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

_RECONCILIATION_PATH = "/api/internal/auto-review/reconcile"
_WAKEUP_INTERVAL_SECONDS = 30.0
_WAKEUP_TIMEOUT_SECONDS = 10.0


def _reconciliation_url() -> str | None:
    base_url = settings.frontend_internal_url.strip().rstrip("/")
    if not base_url or not settings.auto_review_reconciliation_secret:
        return None
    return f"{base_url}{_RECONCILIATION_PATH}"


def assert_auto_review_reconciliation_capability() -> None:
    """Refuse the new backend until the canonical database contract exists."""
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError(
            "Auto-review reconciliation requires SUPABASE_URL and SUPABASE_SERVICE_KEY."
        )

    try:
        result = get_supabase().rpc("auto_review_reconciliation_capability").execute()
    except Exception as error:
        raise RuntimeError(
            "Database migration for auto-review reconciliation is not available."
        ) from error

    if result.data is not True:
        raise RuntimeError(
            "Database migration returned an invalid auto-review capability."
        )


async def wake_auto_review_reconciliation(
    client: httpx.AsyncClient | None = None,
) -> bool:
    """Ask the frontend to drain the durable outbox, without owning its state."""
    url = _reconciliation_url()
    if url is None:
        logger.warning(
            "Auto-review reconciliation wakeup disabled: configure "
            "FRONTEND_INTERNAL_URL and AUTO_REVIEW_RECONCILIATION_SECRET."
        )
        return False

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=_WAKEUP_TIMEOUT_SECONDS)

    try:
        response = await client.post(
            url,
            headers={
                "Authorization": (
                    f"Bearer {settings.auto_review_reconciliation_secret}"
                )
            },
        )
        response.raise_for_status()
        return True
    except Exception:
        # A RPC que publicou a resposta também gravou a outbox. Portanto, a
        # falha deste sinal não perde trabalho: o próximo tick tenta o dreno.
        logger.warning("Failed to wake auto-review reconciliation", exc_info=True)
        return False
    finally:
        if owns_client:
            await client.aclose()


async def run_auto_review_reconciliation_wakeup_loop(
    *, interval_seconds: float = _WAKEUP_INTERVAL_SECONDS
) -> None:
    """Wake the frontend immediately and periodically until cancellation."""
    async with httpx.AsyncClient(timeout=_WAKEUP_TIMEOUT_SECONDS) as client:
        while True:
            await wake_auto_review_reconciliation(client)
            await asyncio.sleep(interval_seconds)
