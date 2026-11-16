import { describe, expect, it } from "vitest";
import { loadReviewerNames } from "@/lib/reviews/reviewer-names";
import {
  makeFilterAwareSupabaseMock,
  type ReadCall,
} from "@/test-utils/supabase-mock";

// Vereditos e dúvidas da tela de Comentários mostravam a parte local do
// e-mail, e as notas da mesma tela, o nome do perfil.

const profiles = [
  { id: "ana", email: "ana.lima@x.com", first_name: "Ana", last_name: "Lima" },
  { id: "bia", email: "bia@x.com", first_name: null, last_name: null },
  { id: "caio", email: "caio@x.com", first_name: "Caio", last_name: null },
];

function load(ids: string[]) {
  const readCalls: ReadCall[] = [];
  const client = makeFilterAwareSupabaseMock({
    tableData: { profiles },
    writeCalls: [],
    readCalls,
    // Como o PostgREST: coluna fora do select não chega.
    projectColumns: true,
  }) as never;
  return { names: loadReviewerNames(client, ids), readCalls };
}

describe("loadReviewerNames", () => {
  it("devolve o nome do perfil, e a parte local do e-mail de quem não tem nome", async () => {
    const { names } = load(["ana", "bia", "ana"]);
    expect([...(await names)]).toEqual([
      ["ana", "Ana Lima"],
      ["bia", "bia"],
    ]);
  });

  it("sem ids, não consulta", async () => {
    const { names, readCalls } = load([]);
    expect((await names).size).toBe(0);
    expect(readCalls).toEqual([]);
  });
});
