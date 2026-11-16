import threading

from supabase import Client, create_client

from config import settings

_client: Client | None = None
_client_lock = threading.Lock()


def get_supabase() -> Client:
    """O cliente do processo, criado uma vez só mesmo com várias threads.

    Rotas síncronas do FastAPI, callbacks do LLM e os lotes de `_select_all`
    chamam daqui de threads diferentes. O cliente do supabase também cria o
    cliente do PostgREST no primeiro acesso, sem trava: ele é tocado aqui,
    dentro da trava, para que duas threads não criem dois.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                client = create_client(
                    settings.supabase_url, settings.supabase_service_key
                )
                client.postgrest  # noqa: B018 (cria o cliente do PostgREST)
                _client = client
    return _client
