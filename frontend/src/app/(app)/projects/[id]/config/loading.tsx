export default function ConfigLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 w-full animate-pulse rounded bg-muted" />
        ))}
      </div>
    </div>
  );
}
