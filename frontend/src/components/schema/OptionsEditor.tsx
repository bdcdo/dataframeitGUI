"use client";

import { useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

interface OptionsEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
}

export function OptionsEditor({ options, onChange }: OptionsEditorProps) {
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

  const removeOption = (index: number) => {
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
