"""Prazo por chamada ao modelo, aplicado pelo runner e aceito por cada provider.

Sem prazo, uma conexão com o provider que fica aberta e muda trava a leitura
para sempre, e a rodada junto. O runner põe `timeout` nos `model_kwargs`, que o
dataframeit entrega ao `init_chat_model` do langchain sem filtrar. Estes testes
cobrem as duas pontas: o default sai de `_normalize_llm_kwargs`, e o nome
`timeout` é aceito pela classe de chat de cada modelo que a tela oferece.
"""

import re
from pathlib import Path

import pytest
from langchain.chat_models import init_chat_model

from services.llm_runner import (
    DEFAULT_LLM_CALL_TIMEOUT_SECONDS,
    _normalize_llm_kwargs,
)

# O registro de modelos da tela é a lista do que um projeto pode rodar. Lê-lo
# daqui, em vez de repetir os nomes, faz um modelo ou provider novo entrar
# neste teste sem ninguém lembrar de acrescentá-lo.
_MODEL_REGISTRY = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "lib"
    / "model-registry.ts"
)
_REGISTRY_ENTRY = re.compile(r'provider:\s*"([^"]+)",\s*model:\s*"([^"]+)"')

# Chave falsa por provider: a construção do cliente exige uma, mas nenhum teste
# aqui faz requisição.
_FAKE_KEYS = {
    "GOOGLE_API_KEY": "fake-google-key",
    "OPENAI_API_KEY": "sk-fake-openai-key",
    "ANTHROPIC_API_KEY": "sk-ant-fake-anthropic-key",
}


def _registry_models() -> list[tuple[str, str]]:
    entries = _REGISTRY_ENTRY.findall(_MODEL_REGISTRY.read_text(encoding="utf-8"))
    assert entries, f"nenhum modelo encontrado em {_MODEL_REGISTRY.name}"
    return entries


def test_default_e_600_segundos():
    assert DEFAULT_LLM_CALL_TIMEOUT_SECONDS == 600


def test_normalize_sem_timeout_entrega_o_default():
    config = _normalize_llm_kwargs({"temperature": 0.2, "track_tokens": True})

    assert config.model_kwargs == {
        "temperature": 0.2,
        "timeout": DEFAULT_LLM_CALL_TIMEOUT_SECONDS,
    }
    # O prazo é do modelo, não do dataframeit: não pode vazar para os
    # parâmetros da biblioteca, que recusaria a chave desconhecida.
    assert "timeout" not in config.dfi_kwargs


@pytest.mark.parametrize("valor", [30, 1800, None])
def test_normalize_com_timeout_mantem_o_do_projeto(valor):
    config = _normalize_llm_kwargs({"timeout": valor})

    assert config.model_kwargs["timeout"] == valor


@pytest.mark.parametrize(("provider", "model"), _registry_models())
def test_provider_aceita_timeout_na_construcao(monkeypatch, provider, model):
    """O kwarg `timeout` vira o prazo da classe de chat, e não um parâmetro de API.

    O risco que este teste pega é silencioso: uma classe que não declara o
    campo não quebra na construção, mas move a chave desconhecida para o
    próprio `model_kwargs` e a manda no corpo da requisição, onde o provider
    recusa com 400 em toda chamada. Por isso a prova é o campo declarado
    (nome ou alias `timeout`, conforme a classe) com o valor, e a chave
    ausente do `model_kwargs` do modelo.
    """
    for name, value in _FAKE_KEYS.items():
        monkeypatch.setenv(name, value)
    model_kwargs = _normalize_llm_kwargs({}).model_kwargs

    # Mesma chamada que o dataframeit faz ao criar o modelo LangChain.
    chat = init_chat_model(model, model_provider=provider, **model_kwargs)

    timeout_fields = [
        field_name
        for field_name, field in type(chat).model_fields.items()
        if "timeout" in (field_name, field.alias)
    ]
    assert len(timeout_fields) == 1, (type(chat).__name__, timeout_fields)
    assert getattr(chat, timeout_fields[0]) == DEFAULT_LLM_CALL_TIMEOUT_SECONDS
    assert "timeout" not in (getattr(chat, "model_kwargs", None) or {})
