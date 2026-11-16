import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  makeSupabaseServerModuleMock,
  type QueryError,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import { reopenReviewComment, resolveReviewComment } from "@/actions/stats";

// O card da revisão com veredito "Ambíguo" esconde, na aba Comentários, o
// comentário kind='ambiguity' da célula que repete a nota dele
// (`buildOrderedComments`). Resolver ou reabrir o card leva o comentário
// junto: senão ele seguia aberto, contado na Comparação, sem card na aba.

let tableData: Record<string, unknown[]>;
let writeCalls: WriteCall[];
let queryErrors: Record<string, QueryError | null>;

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls, queryErrors });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ getAuthUser: async () => ({ id: "coord-1" }) }));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));

const NOTE = "a pergunta admite duas leituras";
const BODY = `Campo marcado como ambíguo na revisão (aba Comparar): ${NOTE}`;

function review(verdict: string) {
  return { id: "r1", project_id: "p1", document_id: "d1", field_name: "q1", verdict, comment: NOTE };
}

const ambiguityWrites = () => callsOf(writeCalls, "update", "project_comments");

beforeEach(() => {
  tableData = { reviews: [review("ambiguo")] };
  writeCalls = [];
  queryErrors = {};
});

describe("resolver e reabrir o card da revisão ambígua", () => {
  it("resolver leva junto o comentário de ambiguidade aberto que o card cobre", async () => {
    expect(await resolveReviewComment("r1", "p1")).toEqual({ success: true });

    const [write] = ambiguityWrites();
    expect(write.payload).toEqual({ resolved_at: expect.any(String), resolved_by: "coord-1" });
    expect(write.filters).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "document_id", "d1"],
      ["eq", "field_name", "q1"],
      ["eq", "kind", "ambiguity"],
      ["eq", "body", BODY],
      // Um comentário já resolvido mantém quem o resolveu.
      ["is", "resolved_at", null],
    ]);
  });

  it("reabrir reabre o comentário que o card cobria", async () => {
    expect(await reopenReviewComment("r1", "p1")).toEqual({ success: true });

    const [write] = ambiguityWrites();
    expect(write.payload).toEqual({ resolved_at: null, resolved_by: null });
    expect(write.filters).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "document_id", "d1"],
      ["eq", "field_name", "q1"],
      ["eq", "kind", "ambiguity"],
      ["eq", "body", BODY],
    ]);
  });

  it("veredito que não é ambíguo não toca project_comments", async () => {
    tableData.reviews = [review("correto")];
    expect(await resolveReviewComment("r1", "p1")).toEqual({ success: true });
    expect(ambiguityWrites()).toEqual([]);
  });

  it("revisão que o usuário não pode resolver não chega ao comentário", async () => {
    tableData.reviews = [];
    expect(await resolveReviewComment("r1", "p1")).toEqual({
      success: false,
      error: "Sem permissão para resolver este comentário",
    });
    expect(ambiguityWrites()).toEqual([]);
  });

  it("falha ao atualizar o comentário avisa, com o texto do banco só no log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    queryErrors["project_comments:update"] = { message: "statement timeout", code: "57014" };

    expect(await resolveReviewComment("r1", "p1")).toEqual({
      success: false,
      error: copyWithRef(
        "O comentário da revisão foi atualizado, mas o de ambiguidade do campo não. Tente novamente.",
      ),
    });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[stats] comentário de ambiguidade da revisão falhou", { code: "57014" }),
    );
    consoleError.mockRestore();
  });
});
