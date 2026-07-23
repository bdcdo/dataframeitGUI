import asyncio
from contextlib import suppress

import httpx
import pytest

import main
from services import auto_review_reconciliation as reconciliation


def _configure_wakeup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        reconciliation.settings,
        "frontend_internal_url",
        "https://frontend.example.com/",
    )
    monkeypatch.setattr(
        reconciliation.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )


def test_wakeup_posts_to_internal_route_with_dedicated_bearer(monkeypatch) -> None:
    _configure_wakeup(monkeypatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204)

    async def scenario() -> bool:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await reconciliation.wake_auto_review_reconciliation(client)

    assert asyncio.run(scenario()) is True
    assert len(requests) == 1
    assert (
        str(requests[0].url)
        == "https://frontend.example.com/api/internal/auto-review/reconcile"
    )
    assert requests[0].headers["Authorization"] == "Bearer reconciliation-secret"


def test_wakeup_failure_is_best_effort(monkeypatch, caplog) -> None:
    _configure_wakeup(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("frontend unavailable", request=request)

    async def scenario() -> bool:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await reconciliation.wake_auto_review_reconciliation(client)

    assert asyncio.run(scenario()) is False
    assert "Failed to wake auto-review reconciliation" in caplog.text


def test_wakeup_is_disabled_without_internal_url(monkeypatch) -> None:
    monkeypatch.setattr(reconciliation.settings, "frontend_internal_url", "")
    monkeypatch.setattr(
        reconciliation.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )

    assert asyncio.run(reconciliation.wake_auto_review_reconciliation()) is False


def test_periodic_loop_repeats_wakeup(monkeypatch) -> None:
    calls: list[object] = []
    called_twice = asyncio.Event()

    async def fake_wakeup(client=None) -> bool:
        calls.append(client)
        if len(calls) == 2:
            called_twice.set()
        return True

    monkeypatch.setattr(reconciliation, "wake_auto_review_reconciliation", fake_wakeup)

    async def scenario() -> None:
        task = asyncio.create_task(
            reconciliation.run_auto_review_reconciliation_wakeup_loop(
                interval_seconds=0
            )
        )
        await asyncio.wait_for(called_twice.wait(), timeout=1)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert len(calls) >= 2
    assert all(call is calls[0] for call in calls)


def test_lifespan_starts_and_stops_periodic_wakeup(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "frontend_internal_url", "https://frontend")
    monkeypatch.setattr(
        main.settings,
        "auto_review_reconciliation_secret",
        "reconciliation-secret",
    )
    capability_checks: list[None] = []
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def fake_loop() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(main, "run_auto_review_reconciliation_wakeup_loop", fake_loop)
    monkeypatch.setattr(
        main,
        "assert_auto_review_reconciliation_capability",
        lambda: capability_checks.append(None),
    )

    async def scenario() -> None:
        async with main.lifespan(main.app):
            await asyncio.wait_for(started.wait(), timeout=1)
        assert stopped.is_set()

    asyncio.run(scenario())
    assert capability_checks == [None]


def test_lifespan_refuses_internal_url_without_dedicated_secret(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "frontend_internal_url", "https://frontend")
    monkeypatch.setattr(main.settings, "auto_review_reconciliation_secret", "")

    async def scenario() -> None:
        with pytest.raises(
            RuntimeError,
            match="AUTO_REVIEW_RECONCILIATION_SECRET",
        ):
            async with main.lifespan(main.app):
                pass

    asyncio.run(scenario())


def test_capability_gate_requires_canonical_database_rpc(monkeypatch) -> None:
    class Rpc:
        def execute(self):
            raise RuntimeError("function does not exist")

    class Supabase:
        def rpc(self, name: str):
            assert name == "auto_review_reconciliation_capability"
            return Rpc()

    monkeypatch.setattr(reconciliation.settings, "supabase_url", "https://db")
    monkeypatch.setattr(reconciliation.settings, "supabase_service_key", "service-key")
    monkeypatch.setattr(reconciliation, "get_supabase", lambda: Supabase())

    with pytest.raises(RuntimeError, match="migration"):
        reconciliation.assert_auto_review_reconciliation_capability()


def test_capability_gate_accepts_migrated_database(monkeypatch) -> None:
    class Rpc:
        data = True

        def execute(self):
            return self

    class Supabase:
        def rpc(self, name: str):
            assert name == "auto_review_reconciliation_capability"
            return Rpc()

    monkeypatch.setattr(reconciliation.settings, "supabase_url", "https://db")
    monkeypatch.setattr(reconciliation.settings, "supabase_service_key", "service-key")
    monkeypatch.setattr(reconciliation, "get_supabase", lambda: Supabase())

    reconciliation.assert_auto_review_reconciliation_capability()
