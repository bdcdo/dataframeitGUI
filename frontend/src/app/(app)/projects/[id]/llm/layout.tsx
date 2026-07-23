import { requireProjectPageAccess } from "@/lib/page-auth";
import { notFound } from "next/navigation";
import LlmNav from "@/components/llm/LlmNav";

export default async function LlmLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { access } = await requireProjectPageAccess(params);
  if (!access.isCoordinator) notFound();

  return (
    <div className="flex flex-col">
      <LlmNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
