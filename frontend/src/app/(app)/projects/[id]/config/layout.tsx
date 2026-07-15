import { redirect } from "next/navigation";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { ConfigNav } from "./ConfigNav";

// Guard server-side centralizado para todas as rotas `config/*`. As abas
// coordinator-only são escondidas no client (ProjectTabs), mas um pesquisador
// que conheça a URL ainda chegaria aqui — por isso o redirect acontece no
// layout, cobrindo cada page filha de uma vez. Ver issue #27.
export default async function ConfigLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user] = await Promise.all([params, getAuthUser()]);
  if (!user) redirect("/auth/login");

  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  if (!access.isCoordinator) {
    redirect(`/projects/${id}/analyze/code`);
  }

  return (
    <div className="flex flex-col">
      <ConfigNav projectId={id} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
