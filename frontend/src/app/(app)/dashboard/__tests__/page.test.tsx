// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  fromTables: [] as string[],
  coordinatorProjectIds: ["project-1"] as string[] | null,
  coordinatorError: null as { message: string } | null,
}));

function makeSupabaseMock() {
  return {
    from(table: string) {
      state.fromTables.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) {
        builder[method] = () => builder;
      }
      builder.single = async () => ({
        data: table === "profiles" ? { first_name: "Conta Alias" } : null,
        error: null,
      });
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data:
            table === "projects"
              ? [
                  {
                    id: "project-1",
                    name: "Projeto canônico",
                    description: "Visível via RLS",
                    created_by: "another-account",
                  },
                ]
              : null,
          error: null,
        });
      return builder;
    },
    rpc: async (fn: string) => {
      expect(fn).toBe("auth_user_coordinator_project_ids");
      return {
        data: state.coordinatorProjectIds,
        error: state.coordinatorError,
      };
    },
  };
}

vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({
    id: "linked-account",
    email: "alias@example.com",
    firstName: "Conta",
    lastName: "Alias",
    clerkId: "clerk-alias",
    isMaster: false,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeSupabaseMock(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/shell/Header", () => ({ Header: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("lucide-react", () => ({ FolderOpen: () => null }));

async function loadPage() {
  return (await import("@/app/(app)/dashboard/page")).default;
}

beforeEach(() => {
  state.fromTables = [];
  state.coordinatorProjectIds = ["project-1"];
  state.coordinatorError = null;
});

afterEach(cleanup);

describe("DashboardPage — memberships canônicas", () => {
  it("lista via RLS o projeto sem filtrar pelo id bruto e exibe o papel canônico", async () => {
    const page = await loadPage();

    render(await page());

    expect(screen.getByText("Projeto canônico")).toBeTruthy();
    expect(screen.getByText("coordenador")).toBeTruthy();
    expect(state.fromTables).toContain("projects");
    expect(state.fromTables).not.toContain("project_members");
  });

  it("não rebaixa silenciosamente para pesquisador quando a RPC de papel falha", async () => {
    state.coordinatorProjectIds = null;
    state.coordinatorError = { message: "rpc indisponível" };
    const page = await loadPage();

    render(await page());

    expect(
      screen.getByText("Não foi possível carregar seus projetos agora."),
    ).toBeTruthy();
    expect(screen.queryByText("pesquisador")).toBeNull();
    expect(screen.queryByText("Projeto canônico")).toBeNull();
  });
});
