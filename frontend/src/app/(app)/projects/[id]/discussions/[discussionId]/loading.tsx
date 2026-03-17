import { Skeleton } from "@/components/ui/skeleton";

export default function DiscussionDetailLoading() {
  return (
    <div className="space-y-6 p-6">
      <Skeleton className="h-5 w-48" />
      <div className="space-y-3">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="space-y-3">
        <Skeleton className="h-5 w-36" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
