import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_MODES } from "@/lib/types";
import {
  makeSupabaseMock,
  type RpcCall,
  type WriteCall,
} from "./supabase-mock";

// Os modos aceitos por createProject e updateProject saem de AUTOMATION_MODES
// (lib/types.ts). A lista derivada não é exportada (arquivo "use server"),
// então os testes a observam pelo que as actions aceitam e recusam.

const hoisted = vi.hoisted(() => ({ redirect: vi.fn() }));

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

async function modeSentOnCreate(mode: string) {
  const { createProject } = await import("@/actions/projects");
  const form = new FormData();
  form.set("name", "Projeto");
  form.set("automation_mode", mode);
  await createProject(null, form);
  expect(rpcCalls).toHaveLength(1);
  return (rpcCalls[0].args as { p_automation_mode: unknown }).p_automation_mode;
}

async function updateMode(mode: string) {
  const { updateProject } = await import("@/actions/projects");
  // O cast imita o cliente que envia um valor fora do tipo AutomationMode.
  return updateProject("project-1", {
    automation_mode: mode as (typeof AUTOMATION_MODES)[number]["value"],
  });
}

describe("modos de automação aceitos pelas actions", () => {
  it.each(AUTOMATION_MODES.map((m) => m.value))(
    "createProject envia '%s' intacto à RPC",
    async (mode) => {
      expect(await modeSentOnCreate(mode)).toBe(mode);
    },
  );

  it.each(AUTOMATION_MODES.map((m) => m.value))(
    "updateProject grava '%s'",
    async (mode) => {
      expect(await updateMode(mode)).toEqual({});
      expect(writeCalls).toEqual([
        { table: "projects", op: "update", payload: { automation_mode: mode } },
      ]);
    },
  );

  it("updateProject recusa modo desconhecido sem tocar no banco", async () => {
    expect(await updateMode("xyz")).toEqual({
      error: "Modo de automação inválido.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("updateProject sem automation_mode não é barrado pela validação", async () => {
    const { updateProject } = await import("@/actions/projects");
    expect(await updateProject("project-1", { name: "Novo nome" })).toEqual({});
    expect(writeCalls).toHaveLength(1);
  });
});

// Uma lista copiada à mão passaria nos testes acima enquanto coincidisse com
// a fonte. Trocar a fonte por uma lista fictícia reprova a cópia já agora:
// o modo acrescentado precisa valer e o retirado precisa deixar de valer.
describe("a lista acompanha AUTOMATION_MODES", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/types", () => ({
      AUTOMATION_MODES: [
        { value: "none", label: "Nenhuma", description: "" },
        { value: "modo_novo", label: "Novo", description: "" },
      ],
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/types");
    vi.resetModules();
  });

  it("modo acrescentado à fonte vale em createProject e updateProject", async () => {
    expect(await modeSentOnCreate("modo_novo")).toBe("modo_novo");
    expect(await updateMode("modo_novo")).toEqual({});
  });

  it("modo retirado da fonte deixa de valer em createProject e updateProject", async () => {
    expect(await modeSentOnCreate("compare_llm")).not.toBe("compare_llm");
    expect(await updateMode("compare_llm")).toEqual({
      error: "Modo de automação inválido.",
    });
  });
});
