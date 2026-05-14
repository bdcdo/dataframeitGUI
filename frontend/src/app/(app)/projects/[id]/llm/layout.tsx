import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { notFound } from "next/navigation";
import LlmNav from "@/components/llm/LlmNav";

export default async function LlmLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) notFound();

  const { isCoordinator, queryFailed } = await getProjectAccessContext(
    id,
    user.id,
    user.isMaster,
  );
  // Fail-open em erro transiente de query (ver getProjectAccessContext): o RLS
  // continua bloqueando os dados se o usuario realmente nao for coordenador.
  if (!isCoordinator && !queryFailed) notFound();

  return (
    <div className="flex flex-col">
      <LlmNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
