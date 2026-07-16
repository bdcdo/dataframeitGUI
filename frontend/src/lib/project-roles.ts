export interface ProjectAlias {
  project_id: string;
  member_user_id: string;
}

export interface ProjectMembershipRole {
  project_id: string;
  user_id: string;
  role: string;
}

export function indexEffectiveIdentityByProject(
  aliases: ProjectAlias[],
): Map<string, string> {
  return new Map(
    aliases.map((alias) => [alias.project_id, alias.member_user_id]),
  );
}

export function indexEffectiveRoleByProject(
  userId: string,
  identityByProject: ReadonlyMap<string, string>,
  memberships: ProjectMembershipRole[],
): Map<string, string> {
  return new Map(
    memberships.flatMap((membership) => {
      const effectiveId = identityByProject.get(membership.project_id) ?? userId;
      return membership.user_id === effectiveId
        ? [[membership.project_id, membership.role] as const]
        : [];
    }),
  );
}

export async function loadAccessibleProjects(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<{
  projects: (Project & { role: string })[];
  error: { message: string } | null;
}> {
  const { data: projectRows, error: projectError } = await supabase
    .from("projects")
    .select("id, name, description, created_by")
    .order("created_at", { ascending: false });
  if (projectError || !projectRows?.length) {
    return { projects: [], error: projectError };
  }

  const projectIds = projectRows.map((project) => project.id);
  const { data: aliases, error: aliasError } = await supabase
    .from("member_email_links")
    .select("project_id, member_user_id")
    .eq("linked_user_id", userId)
    .in("project_id", projectIds);
  if (aliasError) return { projects: [], error: aliasError };

  const identityByProject = indexEffectiveIdentityByProject(aliases ?? []);
  const identityIds = [...new Set([userId, ...identityByProject.values()])];
  const { data: memberships, error: membershipError } = await supabase
    .from("project_members")
    .select("project_id, user_id, role")
    .in("project_id", projectIds)
    .in("user_id", identityIds);
  if (membershipError) return { projects: [], error: membershipError };

  const roleByProject = indexEffectiveRoleByProject(
    userId,
    identityByProject,
    memberships ?? [],
  );
  const projects: (Project & { role: string })[] = [];
  for (const project of projectRows) {
    const effectiveId = identityByProject.get(project.id) ?? userId;
    const role = roleByProject.get(project.id);
    if (!role && project.created_by !== effectiveId) {
      return {
        projects: [],
        error: { message: `Projeto ${project.id} não possui papel canônico para o usuário.` },
      };
    }
    projects.push({
      ...(project as unknown as Project),
      role: role ?? "coordenador",
    });
  }
  return {
    projects,
    error: null,
  };
}
import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { Project } from "@/lib/types";
