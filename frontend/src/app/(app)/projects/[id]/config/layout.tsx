import { redirect } from "next/navigation";
import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
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
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const { isCoordinator, queryFailed } = await getProjectAccessContext(
    id,
    user.id,
    user.isMaster,
  );
  // Fail-open quando a verificação não pôde ser feita (timeout, RLS): nao
  // derrubamos um coordenador legitimo por erro transiente — o RLS continua
  // sendo o backstop real dos dados de config.
  if (!isCoordinator && !queryFailed) {
    redirect(`/projects/${id}/my-progress`);
  }

  return (
    <div className="flex flex-col">
      <ConfigNav projectId={id} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
