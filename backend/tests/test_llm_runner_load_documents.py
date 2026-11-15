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


def test_pendentes_considera_candidatos_alem_do_max_rows():
    # 1200 documentos, todos já com resposta LLM menos o último em ordem de id.
    # A contagem vem embutida em cada documento, e a primeira fase tem de ler
    # os 1200 candidatos, e não só os 1000 do max_rows, para achar o pendente.
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


def _llm_response(i: int, doc_id: str, **overrides) -> dict:
    return {
        "id": f"resp-{i:05d}",
        "document_id": doc_id,
        "project_id": PROJECT_ID,
        "respondent_type": "llm",
        "is_latest": True,
        **overrides,
    }


def _texts_read(sb) -> list[str]:
    """Ids dos documentos cujo `text` alguma leitura baixou."""
    return [
        row["id"]
        for _columns, rows in sb.table("documents").reads
        for row in rows
        if "text" in row
    ]


def test_amostra_baixa_o_texto_so_dos_sorteados():
    # Fase 1 só com ids; o `text` vem depois, só dos 10 escolhidos, e não dos
    # 200 documentos do projeto.
    sb = _supabase(_documents(200))

    sample = _load(sb, "random_sample", sample_size=10)

    assert sorted(_texts_read(sb)) == sorted(d["id"] for d in sample)
    assert all(d["text"] for d in sample)
    candidate_reads = [c for c, _ in sb.table("documents").reads if "text" not in c]
    assert candidate_reads and all(c == "id" for c in candidate_reads)


def test_amostra_mantem_a_ordem_do_sorteio():
    # A segunda fase lê em ordem de id, mas a run recebe a ordem da amostra,
    # a mesma de antes das 2 fases.
    docs = _documents(200)
    ids = sorted(d["id"] for d in docs)

    sample = _load(_supabase(docs), "random_sample", sample_size=10)

    assert [d["id"] for d in sample] == random.Random("job-1").sample(ids, 10)


def test_pendentes_baixa_o_texto_so_dos_pendentes():
    docs = _documents(300)
    ids = sorted(d["id"] for d in docs)
    responses = [_llm_response(i, doc_id) for i, doc_id in enumerate(ids[5:])]
    sb = _supabase(docs, responses)

    pending = _load(sb, "pending")

    assert [d["id"] for d in pending] == ids[:5]
    assert sorted(_texts_read(sb)) == ids[:5]


def test_pendentes_conta_as_respostas_no_banco():
    # A contagem vem embutida na leitura de documents (`responses(count)`):
    # nenhuma linha de responses é baixada para contar em Python.
    docs = _documents(20)
    ids = sorted(d["id"] for d in docs)
    sb = _supabase(docs, [_llm_response(0, ids[0])])

    _load(sb, "pending")

    assert sb.table("responses").reads == []


def test_max_responses_conta_so_respostas_llm_vigentes_do_projeto():
    # Resposta humana, versão antiga e resposta de outro projeto não contam.
    docs = _documents(4)
    a, b, c, d = sorted(x["id"] for x in docs)
    responses = [
        _llm_response(0, a),
        _llm_response(1, a),
        _llm_response(2, b),
        _llm_response(3, b, respondent_type="humano"),
        _llm_response(4, b, is_latest=False),
        _llm_response(5, c, project_id="outro"),
    ]

    chosen = llm_runner._load_documents_for_run(
        _supabase(docs, responses),
        PROJECT_ID,
        None,
        "max_responses",
        1,
        None,
        sample_seed="job-1",
    )

    assert [x["id"] for x in chosen] == [b, c, d]


def test_nenhum_pendente_nao_vira_todos_os_documentos():
    # Uma escolha vazia não pode ser lida como "sem restrição de ids".
    docs = _documents(5)
    responses = [_llm_response(i, d["id"]) for i, d in enumerate(docs)]
    sb = _supabase(docs, responses)

    assert _load(sb, "pending") == []
    assert _texts_read(sb) == []


def test_documento_excluido_entre_as_fases_sai_da_run(monkeypatch):
    docs = _documents(4)
    first, *_, last = sorted(docs, key=lambda d: d["id"])
    original = llm_runner._choose_document_ids

    def choose_and_exclude(*args, **kwargs):
        chosen = original(*args, **kwargs)
        first["excluded_at"] = "agora"
        return chosen

    monkeypatch.setattr(llm_runner, "_choose_document_ids", choose_and_exclude)

    # `last` já respondido: a escolha não é o escopo todo, e o texto vem da
    # segunda fase, que reaplica o escopo.
    loaded = _load(_supabase(docs, [_llm_response(0, last["id"])]), "pending")

    assert [d["id"] for d in loaded] == sorted(d["id"] for d in docs)[1:3]


def test_selecao_de_ids_vai_em_lotes_no_filtro_in(monkeypatch):
    # O `in` vai inteiro na URL: uma seleção grande tem de ser fatiada, nos
    # dois modos de leitura (com e sem 2 fases).
    docs = _documents(450)
    wanted = sorted(d["id"] for d in docs)[:430]
    sizes: list[int] = []
    original_in = _FakeQuery.in_

    def recording_in(self, column, values):
        sizes.append(len(values))
        return original_in(self, column, values)

    monkeypatch.setattr(_FakeQuery, "in_", recording_in)

    loaded = _load(_supabase(docs), ids=wanted)
    sampled = _load(_supabase(docs), "random_sample", sample_size=420, ids=wanted)

    assert [d["id"] for d in loaded] == wanted
    assert len(sampled) == 420 and set(d["id"] for d in sampled) <= set(wanted)
    assert sizes and max(sizes) <= llm_runner._ID_BATCH_SIZE


def test_select_all_by_ids_junta_os_lotes_em_ordem_e_sem_repetir():
    docs = _documents(40)
    ids = [d["id"] for d in docs]  # ordem física embaralhada
    wanted = ids[:25] + ids[:3]  # com repetição
    sizes: list[int] = []
    sb = _supabase(docs)

    def build_query():
        query = sb.table("documents").select("id")
        original_in = query.in_

        def recording_in(column, values):
            sizes.append(len(values))
            return original_in(column, values)

        query.in_ = recording_in
        return query

    rows = llm_runner._select_all_by_ids(build_query, wanted, batch_size=10)

    assert [r["id"] for r in rows] == sorted(set(wanted))
    # Um pedido por lote: um lote completo dispensa a página vazia.
    assert sizes == [10, 10, 5]


def test_lote_incompleto_ainda_pede_a_pagina_seguinte():
    # Um lote que volta com menos linhas que ids pode ter sido cortado por um
    # max-rows menor que o lote; só a página vazia prova que acabou.
    docs = _documents(30)
    wanted = sorted(d["id"] for d in docs) + ["doc-inexistente"]
    sb = _supabase(docs, max_rows=7)

    rows = llm_runner._select_all_by_ids(
        lambda: sb.table("documents").select("id"), wanted, batch_size=31
    )

    assert [r["id"] for r in rows] == wanted[:-1]


def test_sem_nada_filtrado_le_o_escopo_sem_lotes(monkeypatch):
    # Amostra maior que o projeto: todos os candidatos ficam, e o texto vem
    # numa leitura paginada só, e não em lotes de ids.
    in_calls: list[int] = []
    original_in = _FakeQuery.in_

    def recording_in(self, column, values):
        in_calls.append(len(values))
        return original_in(self, column, values)

    monkeypatch.setattr(_FakeQuery, "in_", recording_in)
    sb = _supabase(_documents(150))

    loaded = _load(sb, "random_sample", sample_size=500)

    assert len(loaded) == 150
    assert in_calls == []
