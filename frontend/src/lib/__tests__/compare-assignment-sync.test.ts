// Ressincronização dos assignments de comparação do projeto inteiro: roda
// depois de gravar o schema e pelo script de pós-deploy. O caso que a motivou:
// a pergunta muda, o veredito perde a validade, e o assignment ficava
// "concluido" com o campo pendente até alguém votar de novo no documento.
import { describe, it, expect, beforeEach } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
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

const client = () => makeFilterAwareSupabaseMock({ tableData, writeCalls }) as never;
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

  it.each([[[]], [["--project"]], [["--all", "--project", "p1"]], [["--desconhecido"]]])(
    "argumentos inválidos (%j) saem com código 2 sem tocar no banco",
    async (argv) => {
      const { code } = await run(argv);
      expect(code).toBe(2);
      expect(writeCalls).toHaveLength(0);
    },
  );
});
