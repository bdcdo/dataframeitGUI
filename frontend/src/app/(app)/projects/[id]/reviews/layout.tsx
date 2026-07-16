import { requirePageAuthUser } from "@/lib/page-auth";
import { ReviewsNav } from "@/components/reviews/ReviewsNav";

export default async function ReviewsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }] = await Promise.all([params, requirePageAuthUser()]);

  return (
    <div className="flex flex-col">
      <ReviewsNav projectId={id} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
