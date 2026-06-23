import { getAuthUser } from "@/lib/auth";
import { ReviewsNav } from "@/components/reviews/ReviewsNav";
import { redirect } from "next/navigation";

export default async function ReviewsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user] = await Promise.all([params, getAuthUser()]);
  if (!user) redirect("/auth/login");

  return (
    <div className="flex flex-col">
      <ReviewsNav projectId={id} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
