import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { getRunningLlmCount } from "@/actions/llm";
import { Header } from "@/components/shell/Header";
import { ProjectTabs } from "@/components/shell/ProjectTabs";
import { notFound, redirect } from "next/navigation";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();

  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  // project + membership vem de getProjectAccessContext (request-scoped via
  // cache()) — mesma leitura reaproveitada pelos layouts filhos config/llm.
  const [{ project, isCoordinator }, { data: profile }, runningLlmCount] =
    await Promise.all([
      getProjectAccessContext(id, user.id, user.isMaster),
      supabase
        .from("profiles")
        .select("first_name")
        .eq("id", user.id)
        .single(),
      // Best-effort: o badge "LLM rodando" e cosmetico. Uma falha aqui (RLS,
      // rede) nao deve derrubar o layout inteiro do projeto — degrada para 0.
      getRunningLlmCount(id).catch(() => 0),
    ]);

  if (!project) notFound();

  // Fetch project members for master impersonation dropdown
  let projectMembers: {
    userId: string;
    name: string;
    email: string;
    role: string;
  }[] = [];
  if (user.isMaster) {
    const { data: members } = await supabase
      .from("project_members")
      .select("user_id, role, profiles(first_name, last_name, email)")
      .eq("project_id", id);
    projectMembers = (members || []).map((m) => {
      const p = m.profiles as unknown as {
        first_name: string | null;
        last_name: string | null;
        email: string;
      };
      return {
        userId: m.user_id,
        name: [p?.first_name, p?.last_name].filter(Boolean).join(" ") || p?.email || "Sem nome",
        email: p?.email || "",
        role: m.role,
      };
    });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header
        projectName={project.name}
        user={{ email: user.email, firstName: profile?.first_name }}
      />
      <ProjectTabs
        projectId={id}
        isCoordinator={isCoordinator}
        isMaster={user.isMaster}
        projectMembers={projectMembers}
        isLlmRunning={runningLlmCount > 0}
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
