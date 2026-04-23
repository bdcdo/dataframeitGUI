import { redirect } from "next/navigation";

export default async function LlmIndex({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/llm/configure`);
}
