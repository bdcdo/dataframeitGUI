import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Anterior / "i/n" / próximo dos cabeçalhos que navegam entre documentos
// (Codificação, tela cheia, Comparação, Auto-revisão, Arbitragem, Comentários e
// Meus vereditos). `index` é zero-based. `buttonClassName` dá o tamanho dos
// botões, que acompanha a altura de cada cabeçalho.
export function DocPager({
  index,
  total,
  onNavigate,
  buttonClassName = "size-6",
}: {
  index: number;
  total: number;
  onNavigate: (index: number) => void;
  buttonClassName?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={() => onNavigate(index - 1)}
        disabled={index === 0}
        title="Documento anterior"
        aria-label="Documento anterior"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">
        {index + 1}/{total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={() => onNavigate(index + 1)}
        disabled={index === total - 1}
        title="Próximo documento"
        aria-label="Próximo documento"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
