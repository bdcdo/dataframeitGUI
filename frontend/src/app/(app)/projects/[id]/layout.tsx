import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
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

  const [{ data: project }, { data: membership }, { data: profile }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, name, created_by")
        .eq("id", id)
        .single(),
      supabase
        .from("project_members")
        .select("role")
        .eq("project_id", id)
        .eq("user_id", user.id)
        .single(),
      supabase
        .from("profiles")
        .select("first_name")
        .eq("id", user.id)
        .single(),
    ]);

  if (!project) notFound();

  const isCoordinator =
    membership?.role === "coordenador" ||
    project.created_by === user.id ||
    user.isMaster;

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
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
