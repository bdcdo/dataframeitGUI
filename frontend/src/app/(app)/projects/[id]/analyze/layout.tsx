import { AnalyzeNav } from "@/components/analyze/AnalyzeNav";

export default async function AnalyzeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="flex flex-col">
      <AnalyzeNav projectId={id} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
