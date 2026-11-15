"""Leitura dos documentos de uma run: ordem estável e sem corte silencioso.

Issue #693. O fake de `test_llm_runner_run_llm.py` imita as duas propriedades
do PostgREST que mascaravam o defeito: sem `.order(...)` as linhas voltam na
ordem da lista, que aqui é embaralhada como a ordem física de uma tabela, e
toda resposta é cortada em `max_rows` sem erro nem aviso.
"""

import random

from test_llm_runner_run_llm import _FakeQuery, _FakeSupabase, _FakeTable

from services import llm_runner

PROJECT_ID = "proj-1"


def _documents(n: int, *, physical_seed: int = 0) -> list[dict]:
    """`n` documentos ativos, guardados numa ordem física embaralhada."""
    docs = [
        {
            "id": f"doc-{i:05d}",
            "project_id": PROJECT_ID,
            "text": f"texto {i}",
            "title": None,
            "external_id": None,
            "excluded_at": None,
            "exclusion_pending_at": None,
        }
        for i in range(n)
    ]
    random.Random(physical_seed).shuffle(docs)
    return docs


def _supabase(docs: list[dict], responses=None, max_rows: int = 1000):
    tables = {"documents": _FakeTable(select_data=docs, max_rows=max_rows)}
    if responses is not None:
        tables["responses"] = _FakeTable(select_data=responses, max_rows=max_rows)
    return _FakeSupabase(tables)


def _load(sb, filter_mode="all", sample_size=None, sample_seed="job-1", ids=None):
    return llm_runner._load_documents_for_run(
        sb,
        PROJECT_ID,
        ids,
        filter_mode,
        None,
        sample_size,
        sample_seed=sample_seed,
    )


def test_le_todos_os_documentos_alem_do_max_rows():
    docs = _load(_supabase(_documents(2500)))

    assert len(docs) == 2500
    assert len({d["id"] for d in docs}) == 2500


def test_le_todos_mesmo_com_max_rows_menor_que_a_pagina_pedida():
    # Um servidor com teto menor que _SELECT_PAGE_SIZE devolve páginas curtas,
    # que não podem ser lidas como "acabou".
    rows = _documents(250)

    docs = _load(_supabase(rows, max_rows=100))

    assert sorted(d["id"] for d in docs) == sorted(r["id"] for r in rows)


def test_devolve_os_documentos_em_ordem_de_id():
    # Independe da ordem física: um UPDATE que mova tuplas não pode mudar qual
    # documento é o canário (df.iloc[0:1], #691).
    ids = [d["id"] for d in _load(_supabase(_documents(30)))]

    assert ids == sorted(ids)


def test_exclusao_durante_a_leitura_nao_pula_documento(monkeypatch):
    # Um coordenador aprova a exclusão de um documento já lido enquanto a run
    # lê a segunda página. Com paginação por offset, todos os seguintes
    # recuariam uma posição e um documento ativo nunca seria lido.
    docs = _documents(2000)
    first = min(docs, key=lambda d: d["id"])
    original_execute = _FakeQuery.execute
    pages_read = 0

    def execute_and_exclude(self):
        nonlocal pages_read
        pages_read += 1
        if pages_read == 2:
            first["excluded_at"] = "agora"
        return original_execute(self)

    monkeypatch.setattr(_FakeQuery, "execute", execute_and_exclude)

    loaded = _load(_supabase(docs))

    assert len(loaded) == 2000
    assert len({d["id"] for d in loaded}) == 2000


def test_respeita_a_selecao_de_ids_com_paginacao():
    docs = _documents(1500)
    wanted = sorted(d["id"] for d in docs)[::2]

    assert [d["id"] for d in _load(_supabase(docs), ids=wanted)] == wanted


def test_amostra_aleatoria_e_reproduzivel_pela_semente_da_run():
    a = _supabase(_documents(200, physical_seed=1))
    b = _supabase(_documents(200, physical_seed=2))

    first = _load(a, "random_sample", sample_size=10, sample_seed="job-x")
    again = _load(b, "random_sample", sample_size=10, sample_seed="job-x")

    assert len(first) == 10
    assert [d["id"] for d in first] == [d["id"] for d in again]


def test_amostra_muda_entre_runs_diferentes():
    sb = _supabase(_documents(200))

    first = _load(sb, "random_sample", sample_size=10, sample_seed="job-x")
    other = _load(sb, "random_sample", sample_size=10, sample_seed="job-y")

    assert {d["id"] for d in first} != {d["id"] for d in other}


def test_pendentes_considera_respostas_alem_do_max_rows():
    # 1200 documentos, todos já com resposta LLM menos o último em ordem de id.
    # Se a leitura das respostas parasse em 1000, ~200 documentos já
    # respondidos voltariam a ser processados (e pagos) como pendentes.
    docs = _documents(1200)
    ids = sorted(d["id"] for d in docs)
    responses = [
        {
            "id": f"resp-{i:05d}",
            "document_id": doc_id,
            "project_id": PROJECT_ID,
            "respondent_type": "llm",
            "is_latest": True,
        }
        for i, doc_id in enumerate(ids[:-1])
    ]
    random.Random(3).shuffle(responses)

    pending = _load(_supabase(docs, responses), "pending")

    assert [d["id"] for d in pending] == [ids[-1]]
