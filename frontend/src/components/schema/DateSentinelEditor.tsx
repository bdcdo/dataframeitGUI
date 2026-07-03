"use client";

import { Label } from "@/components/ui/label";
import { OptionsEditor } from "./OptionsEditor";

interface DateSentinelEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
  onBeforeRemoveOption?: (option: string) => Promise<boolean> | boolean;
}

/**
 * Valores sentinela de campos date (ex: "Não identificável"), compartilhado
 * entre FieldCard e EditFieldDialog.
 */
export function DateSentinelEditor({
  options,
  onChange,
  onBeforeRemoveOption,
}: DateSentinelEditorProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Valores sentinela (opcional)</Label>
      <p className="text-xs text-muted-foreground">
        Aparecem como botões ao lado do campo de data (ex: &quot;Não identificável&quot;).
      </p>
      <OptionsEditor
        options={options}
        onChange={onChange}
        onBeforeRemove={onBeforeRemoveOption}
      />
    </div>
  );
}
