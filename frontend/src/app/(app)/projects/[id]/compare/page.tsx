import { redirect } from "next/navigation";

export default async function CompareRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/analyze/compare`);
}
