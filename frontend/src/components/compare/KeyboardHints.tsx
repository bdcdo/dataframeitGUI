"use client";

import { useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";

interface KeyboardHintsProps {
  responseCount: number;
}

export function KeyboardHints({ responseCount }: KeyboardHintsProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t px-4 py-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1.5 px-2 text-xs text-muted-foreground"
        onClick={() => setOpen(!open)}
      >
        <Keyboard className="h-3 w-3" />
        Atalhos
        <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">?</kbd>
      </Button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">1</kbd>
            {responseCount > 1 && (
              <>–<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{responseCount}</kbd></>
            )}
            {" "}Escolher
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">A</kbd> Ambíguo
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">S</kbd> Pular
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">P</kbd> Anterior
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">N</kbd> Próximo
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl+Shift+F</kbd> Tela cheia
          </span>
        </div>
      )}
    </div>
  );
}
