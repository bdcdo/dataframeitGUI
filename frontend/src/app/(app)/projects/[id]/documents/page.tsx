import { redirect } from "next/navigation";

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/config/documents`);
}
