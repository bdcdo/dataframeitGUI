import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import { createFilterAwareProjectIdentityActionHarness } from "./project-identity-harness";

const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createFilterAwareProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("@/lib/auth", () => harness.authModule);
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);

beforeEach(() => {
  harness.reset({
    researcher_field_orders: [
      { project_id: "project-1", user_id: "canonical-member", field_order: ["field_a"], secret: "não projetar" },
    ],
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
      filters: [],
    });
  });

  it("não devolve preferência de outro projeto ou usuário", async () => {
    harness.supabase.tableData.researcher_field_orders = [
      { project_id: "outro", user_id: "canonical-member", field_order: ["outro-projeto"] },
      { project_id: "project-1", user_id: "outro", field_order: ["outro-usuário"] },
    ];
    const { getResearcherFieldOrder } = await import("@/actions/field-order");
    expect(await getResearcherFieldOrder("project-1")).toEqual({ order: null });
    expect(harness.supabase.readCalls).toEqual([{
      table: "researcher_field_orders",
      columns: "field_order",
      filters: [["eq", "project_id", "project-1"], ["eq", "user_id", "canonical-member"]],
    }]);
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
    ["leitura", "select", async (m: typeof import("@/actions/field-order")) => m.getResearcherFieldOrder("project-1"),
      { order: null, error: copyWithRef("Não foi possível carregar a ordem dos campos.") }],
    ["gravação", "upsert", async (m: typeof import("@/actions/field-order")) => m.saveResearcherFieldOrder("project-1", ["field_b"]),
      { success: false, error: copyWithRef("Não foi possível salvar a ordem dos campos. Tente novamente.") }],
  ])("%s: copy pt-BR no retorno, texto cru no log", async (_, op, run, expected) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.supabase.queryErrors[`researcher_field_orders:${op}`] = pgError;

    expect(await run(await import("@/actions/field-order"))).toEqual(expected);
    // Uma linha só: o serverErrorCopy loga, e um console.error próprio da
    // action duplicaria o evento.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine(/\[field-order\] .* falhou/, pgError),
    );
    consoleError.mockRestore();
  });
});
