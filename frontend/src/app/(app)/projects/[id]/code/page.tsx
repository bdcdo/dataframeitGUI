import { redirect } from "next/navigation";

export default async function CodeRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/analyze/code`);
}
