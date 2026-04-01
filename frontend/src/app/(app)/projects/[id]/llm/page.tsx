import { redirect } from "next/navigation";

export default async function LlmRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/config/llm`);
}
