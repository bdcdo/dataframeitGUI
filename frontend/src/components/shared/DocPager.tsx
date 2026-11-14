import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Anterior / "i/n" / próximo dos cabeçalhos de Comparação, Auto-revisão e
// Arbitragem. `index` é zero-based.
export function DocPager({
  index,
  total,
  onNavigate,
}: {
  index: number;
  total: number;
  onNavigate: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={() => onNavigate(index - 1)}
        disabled={index === 0}
        title="Documento anterior"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="text-xs text-muted-foreground">
        {index + 1}/{total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={() => onNavigate(index + 1)}
        disabled={index === total - 1}
        title="Próximo documento"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
