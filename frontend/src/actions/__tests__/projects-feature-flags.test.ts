import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let tableResults: TableResults;
let writeCalls: WriteCall[];

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "user-coord" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults, writeCalls }),
}));

import { createProject, updateProject } from "../projects";

const originalFlag = process.env.NEXT_PUBLIC_LLM_ENABLED;

function projectForm(mode?: string): FormData {
  const formData = new FormData();
  formData.set("name", "Projeto");
  formData.set("description", "Descrição");
  if (mode !== undefined) formData.set("automation_mode", mode);
  return formData;
}

function projectInsert(): Record<string, unknown> | undefined {
  return writeCalls.find(
    ({ table, op }) => table === "projects" && op === "insert",
  )?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_LLM_ENABLED = "false";
  writeCalls = [];
  tableResults = {
    projects: { data: { id: "p1" }, error: null },
    project_members: { data: null, error: null },
  };
  mocks.redirect.mockReset();
});

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_LLM_ENABLED = originalFlag;
  }
});

describe("createProject sem LLM", () => {
  it("usa none como default e persiste comparison_includes_llm=false", async () => {
    const result = await createProject(null, projectForm());

    expect(result).toBeUndefined();
    expect(projectInsert()).toMatchObject({
      automation_mode: "none",
      comparison_includes_llm: false,
    });
  });

  it("mantém compare_humans como opção permitida", async () => {
    await createProject(null, projectForm("compare_humans"));

    expect(projectInsert()).toMatchObject({
      automation_mode: "compare_humans",
      comparison_includes_llm: false,
    });
  });

  it("preserva o default auto_review_llm quando a flag não está definida", async () => {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;

    await createProject(null, projectForm());

    expect(projectInsert()).toMatchObject({
      automation_mode: "auto_review_llm",
    });
    expect(projectInsert()).not.toHaveProperty("comparison_includes_llm");
  });

  it("faz fallback para none diante de um valor desconhecido", async () => {
    await createProject(null, projectForm("modo-inventado"));

    expect(projectInsert()).toMatchObject({ automation_mode: "none" });
  });

  it.each(["auto_review_llm", "compare_llm"])(
    "rejeita payload forjado com o modo %s",
    async (mode) => {
      const result = await createProject(null, projectForm(mode));

      expect(result?.error).toMatch(/desabilitadas/i);
      expect(projectInsert()).toBeUndefined();
    },
  );

  it("rejeita comparison_includes_llm=true forjado na criação", async () => {
    const formData = projectForm("compare_humans");
    formData.set("comparison_includes_llm", "true");

    const result = await createProject(null, formData);

    expect(result?.error).toMatch(/desabilitadas/i);
    expect(projectInsert()).toBeUndefined();
  });
});

describe("updateProject sem LLM", () => {
  it.each([
    { automation_mode: "auto_review_llm" as const },
    { automation_mode: "compare_llm" as const },
    { comparison_includes_llm: true },
  ])("rejeita payload forjado $automation_mode", async (payload) => {
    const result = await updateProject("p1", payload);

    expect(result.error).toMatch(/desabilitadas/i);
    expect(writeCalls).toHaveLength(0);
  });

  it("aceita transição explícita para compare_humans sem LLM", async () => {
    tableResults.projects = { data: [{ id: "p1" }], error: null };

    const result = await updateProject("p1", {
      automation_mode: "compare_humans",
      comparison_includes_llm: false,
    });

    expect(result.error).toBeUndefined();
    expect(writeCalls).toContainEqual({
      table: "projects",
      op: "update",
      payload: {
        automation_mode: "compare_humans",
        comparison_includes_llm: false,
      },
    });
  });
});
