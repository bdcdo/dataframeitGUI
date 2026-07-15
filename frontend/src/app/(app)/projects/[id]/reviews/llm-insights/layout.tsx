import { isLlmEnabled } from "@/lib/feature-flags";
import { redirect } from "next/navigation";

export default async function LlmInsightsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isLlmEnabled()) redirect(`/projects/${id}/analyze/code`);
  return children;
}
