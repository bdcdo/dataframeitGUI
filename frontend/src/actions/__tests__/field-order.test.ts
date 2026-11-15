import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectIdentityActionHarness } from "./project-identity-harness";

const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("@/lib/auth", () => harness.authModule);
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);

beforeEach(() => {
  harness.reset({
    researcher_field_orders: { data: { field_order: ["field_a"] } },
  });
  resolveMemberUserId.mockReset();
  resolveMemberUserId.mockResolvedValue("canonical-member");
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/field-order");
}, 30_000);

describe("researcher field order — identidade canônica", () => {
  it("lê a preferência do membro canônico da conta-alias", async () => {
    const { getResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await getResearcherFieldOrder("project-1");

    expect(result).toEqual({ order: ["field_a"] });
    expect(resolveMemberUserId).toHaveBeenCalledWith("project-1");
  });

  it("grava a preferência em nome do membro canônico", async () => {
    harness.supabase.tableResults!.researcher_field_orders = { error: null };
    const { saveResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await saveResearcherFieldOrder("project-1", ["field_b"]);

    expect(result).toEqual({ success: true });
    expect(harness.supabase.writeCalls).toContainEqual({
      table: "researcher_field_orders",
      op: "upsert",
      payload: {
        project_id: "project-1",
        user_id: "canonical-member",
        field_order: ["field_b"],
        updated_at: expect.any(String),
      },
    });
  });

  it("não lê nem grava quando a identidade canônica está indisponível", async () => {
    resolveMemberUserId.mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const { saveResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await saveResearcherFieldOrder("project-1", ["field_b"]);

    expect(result).toEqual({
      success: false,
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(harness.supabase.writeCalls).toEqual([]);
  });
});

// O texto do Postgres ia cru, em inglês, ao toast pt-BR: vai ao log do
// servidor, e a action devolve a copy do fluxo (#502).
describe("researcher field order — erro do banco", () => {
  const pgError = { code: "57014", message: "canceling statement due to statement timeout" };

  it.each([
    ["leitura", async (m: typeof import("@/actions/field-order")) => m.getResearcherFieldOrder("project-1"),
      { order: null, error: "Não foi possível carregar a ordem dos campos." }],
    ["gravação", async (m: typeof import("@/actions/field-order")) => m.saveResearcherFieldOrder("project-1", ["field_b"]),
      { success: false, error: "Não foi possível salvar a ordem dos campos. Tente novamente." }],
  ])("%s: copy pt-BR no retorno, texto cru no log", async (_, run, expected) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.supabase.tableResults!.researcher_field_orders = { error: pgError };

    expect(await run(await import("@/actions/field-order"))).toEqual(expected);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[field-order\] .* falhou$/),
      pgError,
    );
    consoleError.mockRestore();
  });
});
