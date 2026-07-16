import { describe, expect, it } from "vitest";
import {
  indexEffectiveIdentityByProject,
  indexEffectiveRoleByProject,
  loadAccessibleProjects,
} from "@/lib/project-roles";
import type { SupabaseServerClient } from "@/lib/supabase/server";

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
};

function makeClient(results: Record<string, QueryResult>): SupabaseServerClient {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "order", "eq", "in"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (result: QueryResult) => unknown) =>
        resolve(results[table] ?? { data: null, error: null });
      return builder;
    },
  } as unknown as SupabaseServerClient;
}

describe("project roles for canonical identities", () => {
  it("projects an alias account through the canonical membership", () => {
    const identities = indexEffectiveIdentityByProject([
      { project_id: "p1", member_user_id: "canonical-1" },
    ]);
    const roles = indexEffectiveRoleByProject("login-alias", identities, [
      { project_id: "p1", user_id: "canonical-1", role: "coordenador" },
      { project_id: "p1", user_id: "login-alias", role: "pesquisador" },
    ]);

    expect(identities.get("p1")).toBe("canonical-1");
    expect(roles.get("p1")).toBe("coordenador");
  });

  it("uses the authenticated identity when the project has no alias", () => {
    const identities = indexEffectiveIdentityByProject([]);
    const roles = indexEffectiveRoleByProject("member-1", identities, [
      { project_id: "p2", user_id: "member-1", role: "pesquisador" },
    ]);

    expect(roles.get("p2")).toBe("pesquisador");
  });

  it("loads an alias project with the canonical role", async () => {
    const client = makeClient({
      projects: {
        data: [
          { id: "p1", name: "Projeto", description: null, created_by: "owner" },
        ],
      },
      member_email_links: {
        data: [{ project_id: "p1", member_user_id: "canonical-1" }],
      },
      project_members: {
        data: [
          {
            project_id: "p1",
            user_id: "canonical-1",
            role: "coordenador",
          },
        ],
      },
    });

    const result = await loadAccessibleProjects(client, "login-alias");
    expect(result.error).toBeNull();
    expect(result.projects).toEqual([
      expect.objectContaining({ id: "p1", role: "coordenador" }),
    ]);
  });

  it("fails closed when the alias lookup fails", async () => {
    const client = makeClient({
      projects: {
        data: [
          { id: "p1", name: "Projeto", description: null, created_by: "owner" },
        ],
      },
      member_email_links: { error: { message: "timeout alias" } },
    });

    await expect(loadAccessibleProjects(client, "login-alias")).resolves.toEqual({
      projects: [],
      error: { message: "timeout alias" },
    });
  });

  it("fails closed instead of inventing a role for an inconsistent project", async () => {
    const client = makeClient({
      projects: {
        data: [
          { id: "p1", name: "Projeto", description: null, created_by: "owner" },
        ],
      },
      member_email_links: { data: [] },
      project_members: { data: [] },
    });

    await expect(loadAccessibleProjects(client, "orphan-login")).resolves.toEqual({
      projects: [],
      error: {
        message: "Projeto p1 não possui papel canônico para o usuário.",
      },
    });
  });
});
