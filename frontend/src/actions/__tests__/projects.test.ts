import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_MODES } from "@/lib/types";
import {
  makeSupabaseMock,
  type RpcCall,
  type WriteCall,
} from "./supabase-mock";

// O modo de automação nas actions de projeto. Os modos aceitos por
// createProject e updateProject saem de AUTOMATION_MODES (lib/types.ts); a
// lista derivada não é exportada (arquivo "use server"), então os testes a
// observam pelo que as actions aceitam e recusam. Projeto sem escolha
// explícita (campo ausente ou valor desconhecido no FormData) nasce sem
// automação; o coordenador liga a automação de propósito.

const hoisted = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// redirect real lança NEXT_REDIRECT; o dublê só registra o destino.
vi.mock("next/navigation", () => ({ redirect: hoisted.redirect }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => ({ id: "user-1" })),
}));

let rpcCalls: RpcCall[];
let writeCalls: WriteCall[];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      rpcCalls,
      writeCalls,
      rpcResults: {
        create_project_with_initial_round: { data: "project-1" },
      },
      // updateOrThrow exige ao menos uma linha devolvida pelo UPDATE.
      tableResults: { projects: { data: [{ id: "project-1" }] } },
    }),
}));

beforeEach(() => {
  rpcCalls = [];
  writeCalls = [];
  hoisted.redirect.mockClear();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function automationModeSent(fields: Record<string, string>) {
  const { createProject } = await import("@/actions/projects");
  await createProject(null, form({ name: "Projeto", ...fields }));
  expect(rpcCalls).toHaveLength(1);
  expect(rpcCalls[0].fn).toBe("create_project_with_initial_round");
  return (rpcCalls[0].args as { p_automation_mode: unknown }).p_automation_mode;
}

async function updateMode(mode: string) {
  const { updateProject } = await import("@/actions/projects");
  // O cast imita o cliente que envia um valor fora do tipo AutomationMode.
  return updateProject("project-1", {
    automation_mode: mode as (typeof AUTOMATION_MODES)[number]["value"],
  });
}

describe("createProject — modo de automação", () => {
  it("sem automation_mode no form → none", async () => {
    expect(await automationModeSent({})).toBe("none");
    expect(hoisted.redirect).toHaveBeenCalledWith("/projects/project-1/documents");
  });

  it("automation_mode desconhecido → none", async () => {
    expect(await automationModeSent({ automation_mode: "xyz" })).toBe("none");
  });

  it.each(AUTOMATION_MODES.map((m) => m.value))(
    "'%s' passa intacto à RPC",
    async (mode) => {
      expect(await automationModeSent({ automation_mode: mode })).toBe(mode);
    },
  );
});

describe("updateProject — modo de automação", () => {
  it.each(AUTOMATION_MODES.map((m) => m.value))("grava '%s'", async (mode) => {
    expect(await updateMode(mode)).toEqual({});
    expect(writeCalls).toEqual([
      { table: "projects", op: "update", payload: { automation_mode: mode } },
    ]);
  });

  it("recusa modo desconhecido sem tocar no banco", async () => {
    expect(await updateMode("xyz")).toEqual({
      error: "Modo de automação inválido.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("sem automation_mode não é barrado pela validação", async () => {
    const { updateProject } = await import("@/actions/projects");
    expect(await updateProject("project-1", { name: "Novo nome" })).toEqual({});
    expect(writeCalls).toHaveLength(1);
  });
});

// Uma lista copiada à mão passaria nos testes acima enquanto coincidisse com
// a fonte. Trocar a fonte por uma lista fictícia reprova a cópia já agora:
// o modo acrescentado precisa valer e o retirado precisa deixar de valer.
describe("a lista de modos acompanha AUTOMATION_MODES", () => {
  const FICTICIOS = ["none", "modo_novo"];

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/types", () => ({
      AUTOMATION_MODES: FICTICIOS.map((value) => ({
        value,
        label: value,
        description: "",
      })),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/types");
    vi.resetModules();
  });

  it("modo acrescentado à fonte vale em createProject e updateProject", async () => {
    expect(await automationModeSent({ automation_mode: "modo_novo" })).toBe(
      "modo_novo",
    );
    expect(await updateMode("modo_novo")).toEqual({});
  });

  it("modo retirado da fonte deixa de valer em createProject e updateProject", async () => {
    // O fallback de createProject também tem de ser um modo da fonte.
    expect(FICTICIOS).toContain(
      await automationModeSent({ automation_mode: "compare_llm" }),
    );
    expect(await updateMode("compare_llm")).toEqual({
      error: "Modo de automação inválido.",
    });
  });
});
