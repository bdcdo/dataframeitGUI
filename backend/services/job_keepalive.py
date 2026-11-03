"""Segura a Machine acordada enquanto houver job de LLM em curso.

Com autostop ligado no fly.toml, o proxy do Fly pausa ou para a Machine que
não vê tráfego. Os jobs rodam em BackgroundTasks depois que o POST /run já
respondeu, então um job longo, sem ninguém olhando a tela, não gera tráfego e o
proxy a pausaria no meio dele. Enquanto houver job ativo, o processo abre uma
requisição a si mesmo pela borda do Fly e a mantém aberta: para o proxy é uma
conexão em curso, e Machine com conexão não é pausada. Sem job, o stream
termina. Hoje a API fica sempre ligada (auto_stop "off", motivo em fly.toml) e
este stream não muda nada; ele fica como proteção dos jobs se o autostop
voltar em outra forma.
"""

import asyncio
import hmac
import logging
import os
import secrets
from collections.abc import AsyncIterator

import httpx

from services.llm_runner import active_job_count

logger = logging.getLogger(__name__)

KEEPALIVE_PATH = "/internal/keepalive"
TOKEN_HEADER = "X-Keepalive-Token"
# Gerado no boot e nunca exposto: só este processo conhece o valor, então
# ninguém de fora segura a Machine ligada abrindo o stream.
_TOKEN = secrets.token_urlsafe(32)
# Um byte a cada 15 s mantém a conexão com dado trafegando, abaixo dos timeouts
# de ociosidade do caminho, e o fim do último job fecha o stream em até 15 s.
_STREAM_TICK_SECONDS = 15.0
_IDLE_CHECK_SECONDS = 5.0
_RETRY_SECONDS = 5.0


def is_keepalive_token(value: str | None) -> bool:
    # Compara bytes, e não str: `hmac.compare_digest` levanta TypeError com str
    # que tenha caractere fora do ASCII, e o Starlette decodifica o header como
    # latin-1, então um header com byte alto viraria 500 em vez do 404 da rota.
    return value is not None and hmac.compare_digest(value.encode(), _TOKEN.encode())


async def keepalive_stream() -> AsyncIterator[bytes]:
    while active_job_count() > 0:
        yield b"\n"
        await asyncio.sleep(_STREAM_TICK_SECONDS)


async def run_job_keepalive_loop(
    client: httpx.AsyncClient | None = None,
    *,
    idle_check_seconds: float = _IDLE_CHECK_SECONDS,
    retry_seconds: float = _RETRY_SECONDS,
) -> None:
    # O Fly injeta as duas variáveis em toda Machine. Fora dele (dev, testes)
    # não há proxy que pause nada, e o loop não faz nada.
    app_name = os.environ.get("FLY_APP_NAME")
    machine_id = os.environ.get("FLY_MACHINE_ID")
    if not app_name or not machine_id:
        return
    url = f"https://{app_name}.fly.dev{KEEPALIVE_PATH}"
    # `fly-force-instance-id` prende a requisição nesta Machine: num deploy
    # bluegreen há duas, e o stream que caísse na nova seguraria a errada.
    headers = {TOKEN_HEADER: _TOKEN, "fly-force-instance-id": machine_id}

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=60.0))
    try:
        while True:
            if active_job_count() == 0:
                await asyncio.sleep(idle_check_seconds)
                continue
            try:
                async with client.stream("GET", url, headers=headers) as response:
                    response.raise_for_status()
                    async for _ in response.aiter_bytes():
                        pass
            except Exception:
                # Conexão caída não encerra o job; só abre a janela em que o
                # proxy poderia pausar a Machine. Reabrir logo é o conserto.
                logger.warning("Job keepalive connection failed", exc_info=True)
                await asyncio.sleep(retry_seconds)
    finally:
        if owns_client:
            await client.aclose()
