// Ressincronização dos assignments de comparação do projeto inteiro: roda
// depois de gravar o schema e pelo script de pós-deploy. O caso que a motivou:
// a pergunta muda, o veredito perde a validade, e o assignment ficava
// "concluido" com o campo pendente até alguém votar de novo no documento.
import { describe, it, expect, beforeEach } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type QueryError,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { CURRENT_HASH } from "@/test-utils/comparison-fixtures";
import { resyncProjectCompareAssignments } from "@/lib/compare-assignment-sync";
import { runResync } from "@/lib/compare-resync-cli";

const HASH = "aaaaaaaaaaaa";
const FIELDS: PydanticField[] = [{
  id: "00000000-0000-4000-8000-000000000001", name: "decisao", type: "single",
  options: ["proc", "improc"], description: "", target: "all", hash: HASH,
}];

let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError | null>;

const client = () => makeFilterAwareSupabaseMock({ tableData, writeCalls, queryErrors }) as never;

// O mock com o índice parcial do banco nas atualizações de `assignments`:
// grava o status na linha, e recusa com 23505 a que tornaria ativa uma segunda
// comparação no mesmo documento.
function activeIndexClient() {
  const base = makeFilterAwareSupabaseMock({ tableData, writeCalls, queryErrors });
  return {
    ...base,
    from: (table: string) => {
      const builder = base.from(table) as Record<string, unknown>;
      if (table !== "assignments") return builder;
      builder.update = (payload: { status: string; completed_at: string | null }) => ({
        eq: async (_column: string, id: string) => {
          const rows = tableData.assignments as Array<{ id: string; document_id: string; status: string; completed_at: string | null }>;
          const row = rows.find((r) => r.id === id)!;
          const otherActive = rows.some((r) => r.document_id === row.document_id && r.id !== id && r.status !== "concluido");
          if (payload.status !== "concluido" && otherActive) {
            return { error: { code: "23505", message: 'duplicate key value violates unique constraint "assignments_one_active_comparacao_per_doc"' } };
          }
          row.status = payload.status;
          row.completed_at = payload.completed_at;
          return { error: null };
        },
      });
      return builder;
    },
  } as never;
}
const updates = () => callsOf(writeCalls, "update", "assignments");

const resp = (id: string, documentId: string, decisao: string) => ({
  id, project_id: "p1", document_id: documentId, respondent_type: "humano", respondent_id: id,
  is_latest: true, is_partial: false, pydantic_hash: CURRENT_HASH,
  schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0,
  answers: { decisao }, answer_field_hashes: null,
});

const review = (id: string, documentId: string, fieldHash: string, reviewer = "rev1") => ({
  id, project_id: "p1", document_id: documentId, reviewer_id: reviewer, field_name: "decisao",
  verdict: "proc", field_hash: fieldHash, chosen_response_id: `${documentId}-a`,
});

const assignment = (id: string, documentId: string, status: string, userId = "rev1") => ({
  id, project_id: "p1", document_id: documentId, user_id: userId, type: "comparacao",
  status, completed_at: status === "concluido" ? "2026-09-01T00:00:00Z" : null,
});

beforeEach(() => {
  writeCalls = [];
  queryErrors = {};
  tableData = {
    projects: [{
      id: "p1", name: "Projeto", pydantic_fields: FIELDS, pydantic_hash: CURRENT_HASH,
      schema_version_major: 2, schema_version_minor: 0, schema_version_patch: 0,
    }],
    assignments: [assignment("a-doc1", "doc1", "concluido"), assignment("a-doc2", "doc2", "concluido")],
    // Os dois documentos divergem em `decisao`.
    responses: [resp("doc1-a", "doc1", "proc"), resp("doc1-b", "doc1", "improc"),
      resp("doc2-a", "doc2", "proc"), resp("doc2-b", "doc2", "improc")],
    // doc1: veredito sobre a pergunta atual; doc2: sobre a versão anterior.
    reviews: [review("r1", "doc1", HASH), review("r2", "doc2", "ffffffffffff")],
    response_equivalences: [],
  };
});

describe("resyncProjectCompareAssignments", () => {
  it("reabre o assignment cujo veredito perdeu a validade e deixa o válido concluído", async () => {
    const report = await resyncProjectCompareAssignments(client(), "p1");

    expect(report).toEqual({
      checked: 2,
      changes: [{ assignmentId: "a-doc2", documentId: "doc2", userId: "rev1", from: "concluido", to: "pendente" }],
    });
    expect(updates()).toEqual([expect.objectContaining({ payload: { status: "pendente", completed_at: null } })]);
  });

  it("dryRun lista o que mudaria sem gravar", async () => {
    const report = await resyncProjectCompareAssignments(client(), "p1", { dryRun: true });

    expect(report.changes.map((c) => c.assignmentId)).toEqual(["a-doc2"]);
    expect(updates()).toHaveLength(0);
  });

  it("é idempotente: com os status já certos, não grava nada", async () => {
    tableData.assignments = [assignment("a-doc1", "doc1", "concluido"), assignment("a-doc2", "doc2", "pendente")];

    const report = await resyncProjectCompareAssignments(client(), "p1");

    expect(report.changes).toEqual([]);
    expect(updates()).toHaveLength(0);
  });

  it("conclui o assignment cujo veredito válido nunca tinha fechado o documento", async () => {
    tableData.assignments = [assignment("a-doc1", "doc1", "em_andamento")];

    const report = await resyncProjectCompareAssignments(client(), "p1");

    expect(report.changes).toEqual([expect.objectContaining({ assignmentId: "a-doc1", to: "concluido" })]);
    expect(updates()[0]?.payload).toMatchObject({ status: "concluido" });
  });

  it("lê além da primeira página do PostgREST", async () => {
    // 1000 reviews de outros revisores antes da que decide o doc1: sem
    // paginar, a do rev1 ficaria de fora e o documento pareceria sem veredito.
    tableData.assignments = [assignment("a-doc1", "doc1", "pendente")];
    tableData.reviews = [
      ...Array.from({ length: 1000 }, (_, i) => review(`x${i}`, "doc1", HASH, `outro${i}`)),
      review("r1", "doc1", HASH),
    ];

    const report = await resyncProjectCompareAssignments(client(), "p1", { dryRun: true });

    expect(report.changes).toEqual([expect.objectContaining({ assignmentId: "a-doc1", to: "concluido" })]);
  });

  // Só uma comparação pode estar ativa por documento (índice parcial
  // assignments_one_active_comparacao_per_doc). Com duas concluídas de rodadas
  // diferentes que regridem, reabre a da rodada mais recente; a antiga bate
  // no índice e fica concluída.
  it("com duas concluídas no mesmo documento e nenhuma ativa, reabre a mais recente", async () => {
    tableData.assignments = [
      { ...assignment("a-antiga", "doc2", "concluido", "rev1"), completed_at: "2026-08-01T00:00:00Z" },
      { ...assignment("a-recente", "doc2", "concluido", "rev2"), completed_at: "2026-09-10T00:00:00Z" },
    ];

    await resyncProjectCompareAssignments(activeIndexClient(), "p1");

    const statusOf = (id: string) =>
      (tableData.assignments as Array<{ id: string; status: string }>).find((a) => a.id === id)?.status;
    expect(statusOf("a-recente")).toBe("pendente");
    expect(statusOf("a-antiga")).toBe("concluido");
  });

  it("não mexe em assignment de outro tipo", async () => {
    tableData.assignments = [{ ...assignment("a-doc2", "doc2", "concluido"), type: "codificacao" }];

    const report = await resyncProjectCompareAssignments(client(), "p1");

    expect(report).toEqual({ checked: 0, changes: [] });
    expect(updates()).toHaveLength(0);
  });
});

describe("runResync (o script de pós-deploy)", () => {
  function run(argv: string[]) {
    const lines: string[] = [];
    const done = runResync({ client: client(), argv, log: (line) => lines.push(line) });
    return done.then((code) => ({ code, lines }));
  }

  it("--dry-run lista a mudança e não grava", async () => {
    const { code, lines } = await run(["--project", "p1", "--dry-run"]);

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/a-doc2.*concluido -> pendente/);
    expect(updates()).toHaveLength(0);
  });

  it("sem --dry-run grava", async () => {
    const { code } = await run(["--project", "p1"]);

    expect(code).toBe(0);
    expect(updates()).toHaveLength(1);
  });

  it("--all percorre todos os projetos", async () => {
    tableData.projects.push({ id: "p2", name: "Outro", pydantic_fields: [], pydantic_hash: null });

    const { code, lines } = await run(["--all", "--dry-run"]);

    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith("projeto "))).toHaveLength(2);
  });

  it("falha num projeto sai com código 1, relatada, sem parar os outros", async () => {
    queryErrors["assignments:select"] = { message: "tempo esgotado" };
    tableData.projects.push({ id: "p2", name: "Outro", pydantic_fields: [], pydantic_hash: null });

    const { code, lines } = await run(["--project", "p1", "--project", "p2"]);

    expect(code).toBe(1);
    expect(lines.filter((l) => l.includes("falhou: assignments: tempo esgotado"))).toHaveLength(2);
  });

  it("--all com a lista de projetos ilegível sai com código 1", async () => {
    queryErrors["projects:select"] = { message: "sem acesso" };

    const { code, lines } = await run(["--all"]);

    expect(code).toBe(1);
    expect(lines).toEqual(["projects: sem acesso"]);
  });

  it.each([[[]], [["--project"]], [["--all", "--project", "p1"]], [["--desconhecido"]]])(
    "argumentos inválidos (%j) saem com código 2 sem tocar no banco",
    async (argv) => {
      const { code } = await run(argv);
      expect(code).toBe(2);
      expect(writeCalls).toHaveLength(0);
    },
  );
});
