import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProfileNames,
  profileFullName,
  respondentDisplayName,
  withProfileNames,
} from "@/lib/respondent-names";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

// #622: a autoria exibida ficava congelada no que o perfil tinha no dia da
// gravação. As leituras derivam o nome do perfil.

afterEach(() => vi.restoreAllMocks());

const member = (
  userId: string,
  profiles: { first_name: string | null; last_name: string | null } | null,
  projectId = "p1",
) => ({ project_id: projectId, user_id: userId, profiles });

function fetchNames(
  members: unknown[],
  queryErrors?: Record<string, { message: string } | null>,
) {
  const client = makeFilterAwareSupabaseMock({
    tableData: { project_members: members },
    writeCalls: [],
    queryErrors,
  }) as never;
  return fetchProfileNames(client, "p1");
}

describe("profileFullName", () => {
  it.each([
    [{ first_name: "Ana", last_name: "Lima" }, "Ana Lima"],
    [{ first_name: " Ana ", last_name: null }, "Ana"],
    [{ first_name: null, last_name: "Lima" }, "Lima"],
    [{ first_name: " ", last_name: "" }, null],
    [null, null],
  ])("%o -> %o", (profile, expected) => {
    expect(profileFullName(profile)).toBe(expected);
  });
});

describe("fetchProfileNames", () => {
  it("devolve o nome dos membros do projeto que têm nome no perfil", async () => {
    const names = await fetchNames([
      member("ana", { first_name: "Ana", last_name: "Lima" }),
      member("bia", { first_name: null, last_name: null }),
      member("caio", null),
      member("dora", { first_name: "Dora", last_name: null }, "outro-projeto"),
    ]);
    expect([...names]).toEqual([["ana", "Ana Lima"]]);
  });

  it("leitura que falha não derruba a tela: sem nomes, e o erro vai para o log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const names = await fetchNames([], {
      "project_members:select": { message: "sem acesso" },
    });
    expect(names.size).toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.any(String), "sem acesso");
  });
});

describe("respondentDisplayName / withProfileNames", () => {
  const names = new Map([["ana", "Ana Lima"]]);
  const human = (extra: Record<string, unknown> = {}) => ({
    respondent_type: "humano",
    respondent_id: "ana",
    respondent_name: "ana@example.com",
    ...extra,
  });

  it("resposta humana mostra o nome do perfil no lugar do e-mail gravado", () => {
    expect(respondentDisplayName(human(), names)).toBe("Ana Lima");
  });

  it.each([
    ["perfil sem nome", human({ respondent_id: "bia", respondent_name: "bia@example.com" }), "bia@example.com"],
    ["resposta sem dono", human({ respondent_id: null }), "ana@example.com"],
    // O modelo é a autoria da resposta LLM, mesmo que o id coincida.
    ["resposta LLM", human({ respondent_type: "llm", respondent_name: "gpt-x" }), "gpt-x"],
  ])("%s fica com o nome gravado", (_caso, row, expected) => {
    expect(respondentDisplayName(row, names)).toBe(expected);
  });

  it("troca só o nome, preserva as demais colunas e a linha que não muda", () => {
    const changed = human({ id: "r1", answers: { a: 1 } });
    const untouched = human({ respondent_type: "llm", respondent_name: "gpt-x" });
    const [first, second] = withProfileNames([changed, untouched], names);
    expect(first).toEqual({ ...changed, respondent_name: "Ana Lima" });
    expect(second).toBe(untouched);
  });

  it("aceita leitura sem linhas", () => {
    expect(withProfileNames(null, names)).toEqual([]);
  });
});
