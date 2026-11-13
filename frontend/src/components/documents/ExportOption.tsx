import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Uma opção de export (caixa, rótulo e ajuda), compartilhada pelos cards da
// página Documentos. Fica travada enquanto os dados carregam: a resposta em
// curso foi montada com o valor anterior e, trocada a opção no meio, chegaria
// depois como se fosse da opção nova.
export function ExportOption({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
      </div>
      <p className="pl-6 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}
