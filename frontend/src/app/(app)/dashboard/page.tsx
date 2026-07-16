import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requirePageAuthUser } from "@/lib/page-auth";
import { Header } from "@/components/shell/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";
import Link from "next/link";
import type { Project } from "@/lib/types";

export default async function DashboardPage() {
  const [user, supabase] = await Promise.all([
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const profilePromise = supabase
    .from("profiles")
    .select("first_name")
    .eq("id", user.id)
    .single();

  const projectsPromise = user.isMaster
    ? createSupabaseAdmin()
        .from("projects")
        .select("id, name, description")
        .order("created_at", { ascending: false })
        .then(({ data, error }) => ({
          projects: (data || []).map((p) => ({
            ...(p as unknown as Project),
            role: "master",
          })) as (Project & { role: string })[],
          error,
        }))
    : Promise.all([
        supabase
          .from("projects")
          .select("id, name, description, created_by")
          .order("created_at", { ascending: false }),
        supabase.rpc("auth_user_coordinator_project_ids"),
      ]).then(
        ([
          { data, error: projectsError },
          { data: coordinatorProjectIds, error: coordinatorProjectsError },
        ]) => {
          const coordinatorIds = new Set(
            (coordinatorProjectIds ?? []) as string[],
          );
          return {
            projects: (data || []).map((project) => ({
              ...(project as unknown as Project),
              role:
                project.created_by === user.id || coordinatorIds.has(project.id)
                  ? "coordenador"
                  : "pesquisador",
            })) as (Project & { role: string })[],
            error: projectsError ?? coordinatorProjectsError,
          };
        },
      );

  const [
    { data: profile, error: profileError },
    { projects, error: membershipsError },
  ] = await Promise.all([profilePromise, projectsPromise]);

  if (profileError) {
    console.error("Dashboard profile query failed", {
      userId: user.id,
      error: profileError.message,
    });
  }

  if (membershipsError) {
    console.error("Dashboard memberships query failed", {
      userId: user.id,
      error: membershipsError.message,
    });
  }

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
          <h1 className="text-2xl font-semibold">Meus Projetos</h1>
          <Link href="/projects/new">
            <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
              Novo Projeto
            </Button>
          </Link>
        </div>

        {membershipsError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">
              Não foi possível carregar seus projetos agora.
            </p>
            <p className="mt-1 text-muted-foreground">
              Isso costuma ser temporário. Recarregue a página em instantes; se
              persistir, procure o coordenador do seu projeto.
            </p>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="size-10 text-muted-foreground/50" />
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
