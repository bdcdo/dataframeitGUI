"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OptionsEditor } from "./OptionsEditor";

interface OptionsAllowOtherEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
  onBeforeRemoveOption?: (option: string) => Promise<boolean> | boolean;
  allowOther: boolean;
  onAllowOtherChange: (checked: boolean) => void;
}

/**
 * Bloco "Opções" + "Permitir Outro: ..." de campos single/multi,
 * compartilhado entre FieldCard (editor de schema) e EditFieldDialog
 * (Comentários / LLM Insights).
 */
export function OptionsAllowOtherEditor({
  options,
  onChange,
  onBeforeRemoveOption,
  allowOther,
  onAllowOtherChange,
}: OptionsAllowOtherEditorProps) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Opções</Label>
        <OptionsEditor
          options={options}
          onChange={onChange}
          onBeforeRemove={onBeforeRemoveOption}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">Permitir &quot;Outro: ...&quot;</Label>
          <p className="text-xs text-muted-foreground">
            Pesquisador pode digitar um valor livre além das opções acima
          </p>
        </div>
        <Switch checked={allowOther} onCheckedChange={onAllowOtherChange} />
      </div>
    </div>
  );
}
