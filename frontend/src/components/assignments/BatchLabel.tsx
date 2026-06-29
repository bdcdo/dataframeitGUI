import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface BatchLabelProps {
  htmlFor: string;
  label: string | null;
  createdAt: string;
}

/** Rótulo de um lote anterior (nome + data) reutilizado nos filtros de lote. */
export function BatchLabel({ htmlFor, label, createdAt }: BatchLabelProps) {
  return (
    <Label htmlFor={htmlFor} className="font-normal">
      {label || "Sem rótulo"}
      <span className="ml-1.5 text-xs text-muted-foreground">
        {format(new Date(createdAt), "dd/MM/yyyy", { locale: ptBR })}
      </span>
    </Label>
  );
}
