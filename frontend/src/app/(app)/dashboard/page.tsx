import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Header } from "@/components/shell/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";
import Link from "next/link";
import type { Project } from "@/lib/types";

export default async function DashboardPage() {
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase
      .from("profiles")
      .select("first_name")
      .eq("id", user.id)
      .single(),
    supabase
      .from("project_members")
      .select("project_id, role, projects(id, name, description)")
      .eq("user_id", user.id),
  ]);

  const projects = (memberships || []).map((m) => ({
    ...(m.projects as unknown as Project),
    role: m.role,
  }));

  return (
    <div className="min-h-screen">
      <Header
        user={{
          email: user.email,
          firstName: profile?.first_name,
        }}
      />
      <main className="mx-auto max-w-4xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Meus Projetos</h1>
          <Link href="/projects/new">
            <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
              Novo Projeto
            </Button>
          </Link>
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum projeto ainda.
            </p>
            <Link href="/projects/new" className="mt-4">
              <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
                Criar primeiro projeto
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card className="transition-colors hover:border-brand/50">
                  <CardHeader>
                    <CardTitle className="text-lg">{project.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {project.description || "Sem descrição"}
                    </p>
                    <span className="mt-2 inline-block rounded-md bg-brand/10 px-2 py-0.5 text-xs text-brand">
                      {project.role}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
