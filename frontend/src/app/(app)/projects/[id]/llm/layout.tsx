import { getAuthUser, getProjectAccessContext } from "@/lib/auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { notFound } from "next/navigation";
import LlmNav from "@/components/llm/LlmNav";

export default async function LlmLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user] = await Promise.all([params, getAuthUser()]);
  if (!user) notFound();

  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  if (!access.isCoordinator) notFound();

  return (
    <div className="flex flex-col">
      <LlmNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
