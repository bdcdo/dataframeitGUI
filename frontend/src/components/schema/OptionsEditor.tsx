"use client";

import { useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

interface OptionsEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
  // Chamado antes de remover uma opção não-vazia. Retornar `false` cancela.
  // Útil para verificar se a opção está em uso por `condition` de outro campo.
  onBeforeRemove?: (option: string) => Promise<boolean> | boolean;
}

export function OptionsEditor({
  options,
  onChange,
  onBeforeRemove,
}: OptionsEditorProps) {
  const lastInputRef = useRef<HTMLInputElement>(null);
  const shouldFocusLast = useRef(false);

  useEffect(() => {
    if (shouldFocusLast.current && lastInputRef.current) {
      lastInputRef.current.focus();
      shouldFocusLast.current = false;
    }
  }, [options.length]);

  const updateOption = (index: number, value: string) => {
    const next = [...options];
    next[index] = value;
    onChange(next);
  };

  const removeOption = async (index: number) => {
    const opt = options[index];
    if (onBeforeRemove && opt.trim() !== "") {
      const ok = await onBeforeRemove(opt);
      if (!ok) return;
    }
    onChange(options.filter((_, i) => i !== index));
  };

  const addOption = () => {
    shouldFocusLast.current = true;
    onChange([...options, ""]);
  };

  return (
    <div className="space-y-2">
      {options.map((opt, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-4 text-right shrink-0">
            {i + 1}.
          </span>
          <Input
            ref={i === options.length - 1 ? lastInputRef : undefined}
            value={opt}
            onChange={(e) => updateOption(i, e.target.value)}
            placeholder={`Opção ${i + 1}`}
            className="h-8 text-sm"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => removeOption(i)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={addOption}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        Adicionar opção
      </Button>
    </div>
  );
}
