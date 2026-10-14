import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, type RpcCall } from "./supabase-mock";

// createProject: o modo de automação que chega à RPC de criação. Projeto sem
// escolha explícita (campo ausente ou valor desconhecido no FormData) nasce
// sem automação; o coordenador liga a automação de propósito.

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

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      rpcCalls,
      rpcResults: {
        create_project_with_initial_round: { data: "project-1" },
      },
    }),
}));

beforeEach(() => {
  rpcCalls = [];
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

describe("createProject — modo de automação", () => {
  it("sem automation_mode no form → none", async () => {
    expect(await automationModeSent({})).toBe("none");
    expect(hoisted.redirect).toHaveBeenCalledWith("/projects/project-1/documents");
  });

  it("automation_mode desconhecido → none", async () => {
    expect(await automationModeSent({ automation_mode: "xyz" })).toBe("none");
  });

  it("automation_mode válido passa intacto", async () => {
    expect(await automationModeSent({ automation_mode: "compare_llm" })).toBe(
      "compare_llm",
    );
  });
});
