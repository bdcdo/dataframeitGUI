"""O cliente do supabase é um só no processo, mesmo com várias threads."""

import threading
import time

from services import supabase_client


class _Client:
    def __init__(self):
        self.postgrest_reads = 0

    @property
    def postgrest(self):
        self.postgrest_reads += 1
        return object()


def test_threads_simultaneas_criam_um_cliente_so(monkeypatch):
    created: list[_Client] = []
    start = threading.Barrier(8, timeout=5)

    def create_client(_url, _key):
        # Criar o cliente leva tempo (lê a config, monta sessões): as outras
        # threads chegam enquanto a primeira ainda cria.
        time.sleep(0.05)
        client = _Client()
        created.append(client)
        return client

    monkeypatch.setattr(supabase_client, "_client", None)
    monkeypatch.setattr(supabase_client, "create_client", create_client)

    results = []

    def call():
        start.wait()
        results.append(supabase_client.get_supabase())

    threads = [threading.Thread(target=call) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(created) == 1
    assert all(result is created[0] for result in results)
    # O cliente do PostgREST nasce dentro da trava, antes de alguém usá-lo.
    assert created[0].postgrest_reads == 1
