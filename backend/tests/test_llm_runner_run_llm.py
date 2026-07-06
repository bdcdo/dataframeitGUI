"""Teste de integração de run_llm (issue #377).

Pré-requisito bloqueante do refactor: hoje nenhum teste chama `run_llm`
diretamente (os outros arquivos `test_llm_runner_*` só cobrem os helpers já
extraídos). Mocka só a fronteira externa — cliente Supabase e `dataframeit` —
e deixa rodar de verdade a compilação Pydantic, o flatten/filtro de campos e a
classificação de cobertura, para servir de rede de segurança antes de extrair
o laço de pós-processamento por linha (linhas 970-1120).

Cobre os 4 cenários pedidos pela issue: happy path, run parcial (não falha),
run comprometida (RuntimeError) e exceção não tratada persistida.
"""

import asyncio
import sys
from types import SimpleNamespace

from services.llm_runner import _jobs, init_job, run_llm

JOB_ID = "job-1"
PROJECT_ID = "proj-1"

PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    campo_a: str = Field(description="Campo A")
    campo_b: str = Field(description="Campo B")
    campo_c: str = Field(description="Campo C")
"""

NESTED_PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Doenca(BaseModel):
    doenca: str = Field(description="Doença")

class Analysis(BaseModel):
    q5: Doenca = Field(description="Q5")
"""


class _FakeQuery:
    """Fake do query builder do Supabase.

    Aplica os filtros .eq()/.in_()/.is_() de verdade em execute() quando
    `data` é uma lista de rows (ex.: "documents"); um "select_data" em
    formato de dict único (ex.: "projects", uma única row já resolvida)
    passa direto, já que os testes atuais nunca variam entre múltiplos
    projetos. Sem filtro real, uma regressão no `.is_("excluded_at",
    "null")` de run_llm (bug histórico documentado em llm_runner.py —
    docs arquivados voltando a receber resposta LLM) passaria batida por
    este "teste de integração".
    """

    def __init__(self, data):
        self._data = data
        self._filters: list[tuple[str, str, object]] = []
        self._single = False

    def eq(self, column, value):
        self._filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self._filters.append(("in", column, values))
        return self

    def is_(self, column, value):
        self._filters.append(("is", column, value))
        return self

    def single(self, *a, **k):
        self._single = True
        return self

    def maybe_single(self, *a, **k):
        self._single = True
        return self

    def _matches(self, row: dict) -> bool:
        for op, column, value in self._filters:
            if op == "eq" and row.get(column) != value:
                return False
            if op == "in" and row.get(column) not in value:
                return False
            if op == "is":
                if value == "null":
                    if row.get(column) is not None:
                        return False
                elif row.get(column) != value:
                    return False
        return True

    def execute(self):
        if isinstance(self._data, list):
            rows = [r for r in self._data if self._matches(r)]
            if self._single:
                return SimpleNamespace(data=rows[0] if rows else None)
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=self._data)


class _RaisingQuery(_FakeQuery):
    def execute(self):
        raise self._data


class _FakeTable:
    def __init__(self, select_data=None, select_error=None):
        self.select_data = select_data
        self.select_error = select_error
        self.insert_calls: list[dict] = []
        self.update_calls: list[dict] = []
        self.name = ""
        self.operation_log: list[tuple[str, str, dict]] = []

    def select(self, *a, **k):
        if self.select_error is not None:
            return _RaisingQuery(self.select_error)
        return _FakeQuery(self.select_data)

    def insert(self, payload):
        self.insert_calls.append(payload)
        self.operation_log.append((self.name, "insert", payload))
        return _FakeQuery(payload)

    def update(self, payload):
        self.update_calls.append(payload)
        self.operation_log.append((self.name, "update", payload))
        return _FakeQuery(payload)


class _FakeSupabase:
    def __init__(self, tables: dict[str, _FakeTable]):
        self._tables = tables
        self.operation_log: list[tuple[str, str, dict]] = []
        for name, table in tables.items():
            table.name = name
            table.operation_log = self.operation_log

    def table(self, name):
        return self._tables[name]


def _project_row(**overrides) -> dict:
    row: dict = {
        "pydantic_code": PYDANTIC_CODE,
        "prompt_template": None,
        "llm_provider": "google",
        "llm_model": "gemini-2.5-flash",
        "llm_kwargs": {},
        "description": None,
        "pydantic_fields": [],
        "schema_version_major": 1,
        "schema_version_minor": 0,
        "schema_version_patch": 0,
    }
    row.update(overrides)
    return row


def _docs(n: int) -> list[dict]:
    # project_id precisa estar presente para o fake filtrar de verdade em
    # .eq("project_id", ...) — a query real roda sobre a tabela inteira,
    # não só as colunas do .select().
    return [
        {
            "id": f"doc-{i}",
            "project_id": PROJECT_ID,
            "text": f"texto {i}",
            "title": f"Doc {i}",
            "external_id": None,
        }
        for i in range(n)
    ]


def _make_fake_dataframeit(row_specs: dict[str, dict], calls: list[dict] | None = None):
    """row_specs: {doc_id: {field: value}}.

    Campos ausentes do spec de um doc simulam resposta incompleta do
    provider (o dataframeit real também não garante 100% de cobertura).
    """

    def _fake(batch_df, model_class, prompt_template, **kwargs):
        if calls is not None:
            calls.append(
                {
                    "model_fields": set(model_class.model_fields),
                    "prompt_template": prompt_template,
                    "kwargs": kwargs,
                }
            )
        out = batch_df.copy()
        field_names = [
            f for f in model_class.model_fields if not f.endswith("_justification")
        ]
        for field in field_names:
            out[field] = [
                row_specs.get(doc_id, {}).get(field) for doc_id in batch_df["id"]
            ]
        out["_dataframeit_status"] = "processed"
        out["_error_details"] = None
        return out

    return _fake


def _build_supabase(project_row, docs, *, documents_error=None) -> _FakeSupabase:
    return _FakeSupabase(
        {
            "projects": _FakeTable(select_data=project_row),
            "documents": _FakeTable(select_data=docs, select_error=documents_error),
            "responses": _FakeTable(),
            "llm_runs": _FakeTable(),
        }
    )


def _run_llm_sync(
    monkeypatch,
    sb: _FakeSupabase,
    row_specs: dict[str, dict],
    *,
    dataframeit_calls: list[dict] | None = None,
) -> None:
    monkeypatch.setattr("services.llm_runner.get_supabase", lambda: sb)
    monkeypatch.setitem(
        sys.modules,
        "dataframeit",
        SimpleNamespace(
            dataframeit=_make_fake_dataframeit(row_specs, dataframeit_calls)
        ),
    )
    init_job(JOB_ID, PROJECT_ID, "all")
    asyncio.run(run_llm(JOB_ID, PROJECT_ID))


def _last_update_where(table: _FakeTable, **kv) -> dict | None:
    for payload in reversed(table.update_calls):
        if all(payload.get(k) == v for k, v in kv.items()):
            return payload
    return None


def teardown_function(_fn):
    _jobs.clear()


def test_run_llm_happy_path(monkeypatch):
    docs = _docs(2)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 2
    assert all(
        row["is_partial"] is False and row["is_latest"] is True for row in inserts
    )
    assert all(row["llm_error"] is None for row in inserts)

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "error_message" not in completion  # sem warnings no happy path

    project_updates = sb.table("projects").update_calls
    assert any("pydantic_hash" in payload for payload in project_updates)


def test_run_llm_routes_kwargs_without_leaking_internal_options(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}}
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            llm_kwargs={
                "include_justifications": True,
                "parallel_requests": 2,
                "rate_limit_delay": 0.25,
                "partial_coverage_threshold": 0.4,
                "run_failure_threshold": 0.9,
                "resume": True,
                "track_tokens": True,
                "temperature": 0.2,
            }
        ),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, dataframeit_calls=dataframeit_calls)

    assert len(dataframeit_calls) == 1
    kwargs = dataframeit_calls[0]["kwargs"]
    assert kwargs["parallel_requests"] == 2
    assert kwargs["rate_limit_delay"] == 0.25
    assert kwargs["resume"] is False
    assert kwargs["track_tokens"] is True
    assert kwargs["model_kwargs"] == {"temperature": 0.2}
    for internal_key in [
        "include_justifications",
        "partial_coverage_threshold",
        "run_failure_threshold",
    ]:
        assert internal_key not in kwargs
        assert internal_key not in kwargs["model_kwargs"]


def test_run_llm_flattens_nested_model_before_adding_justifications(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"q5__doenca": "AME"}}
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            pydantic_code=NESTED_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, dataframeit_calls=dataframeit_calls)

    model_fields = dataframeit_calls[0]["model_fields"]
    assert "q5__doenca" in model_fields
    assert "q5__doenca_justification" in model_fields
    assert "q5_justification" not in model_fields


def test_run_llm_marks_previous_llm_responses_before_inserting_new_ones(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    operations = [
        (table, operation, payload)
        for table, operation, payload in sb.operation_log
        if table == "responses"
    ]
    update_index = next(
        i
        for i, (_, operation, payload) in enumerate(operations)
        if operation == "update" and payload == {"is_latest": False}
    )
    first_insert_index = next(
        i for i, (_, operation, _) in enumerate(operations) if operation == "insert"
    )
    assert update_index < first_insert_index


def test_run_llm_completes_empty_run_without_calling_dataframeit(monkeypatch):
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(_project_row(), [])

    _run_llm_sync(monkeypatch, sb, row_specs={}, dataframeit_calls=dataframeit_calls)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _jobs[JOB_ID]["total"] == 0
    assert dataframeit_calls == []
    assert sb.table("responses").insert_calls == []
    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert completion["progress"] == 0
    assert completion["total"] == 0


def test_run_llm_skips_excluded_documents(monkeypatch):
    """Guarda o filtro `.is_("excluded_at", "null")` em run_llm — bug
    histórico documentado em llm_runner.py: o backend não filtrava docs
    arquivados, recriando respostas LLM neles. O fake precisa aplicar esse
    filtro de verdade (ver _FakeQuery._matches); senão este teste passaria
    mesmo com o filtro quebrado.
    """
    docs = _docs(2)
    docs.append(
        {
            "id": "doc-archived",
            "project_id": PROJECT_ID,
            "text": "texto arquivado",
            "title": "Doc arquivado",
            "external_id": None,
            "excluded_at": "2026-01-01T00:00:00Z",
        }
    )
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    inserts = sb.table("responses").insert_calls
    assert {row["document_id"] for row in inserts} == {"doc-0", "doc-1"}


def test_run_llm_partial_run_does_not_fail(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # doc-0 só recebe 1 de 3 campos -> coverage 0.33 < 0.5 (partial_coverage_threshold)
    row_specs["doc-0"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _jobs[JOB_ID]["processed_partial"] == 1
    assert _jobs[JOB_ID]["processed_complete"] == 3
    assert _jobs[JOB_ID]["processed_empty"] == 0

    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 4
    partial_row = next(row for row in inserts if row["document_id"] == "doc-0")
    assert partial_row["is_partial"] is True
    assert (
        partial_row["is_latest"] is False
    )  # respostas parciais nascem is_latest=false

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "Warnings (1 doc(s))" in completion["error_message"]


def test_run_llm_compromised_run_raises_runtime_error(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # 2 de 4 docs com cobertura baixa -> partial_ratio 0.5 >= run_failure_threshold (0.3)
    row_specs["doc-0"] = {"campo_a": "a"}
    row_specs["doc-1"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "RuntimeError"
    assert "Run comprometida" in _jobs[JOB_ID]["errors"][0]

    # As respostas já foram gravadas (com is_latest=false) ANTES do raise —
    # o RuntimeError só marca a run como erro, não desfaz o que já foi salvo.
    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 4

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "Run comprometida" in error_update["error_message"]


def test_run_llm_unhandled_exception_is_persisted(monkeypatch):
    sb = _build_supabase(_project_row(), _docs(2), documents_error=ValueError("boom"))

    _run_llm_sync(monkeypatch, sb, row_specs={})

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "ValueError"
    assert _jobs[JOB_ID]["errors"] == ["boom"]

    # Falhou antes de qualquer processamento: nenhuma resposta foi inserida.
    assert sb.table("responses").insert_calls == []

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert error_update["error_message"] == "boom"
