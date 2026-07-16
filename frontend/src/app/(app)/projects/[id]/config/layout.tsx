import { redirect } from "next/navigation";
import { requireProjectPageAccess } from "@/lib/page-auth";
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
  const { id, access } = await requireProjectPageAccess(params);
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
