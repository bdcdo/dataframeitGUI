"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CustomAnswerInputProps {
  // Chamado com o valor digitado quando o revisor confirma a resposta nova.
  // O pai grava como verdict SEM chosenResponseId — nenhuma resposta existente
  // é o gabarito.
  onSubmit: (value: string) => void;
}

// "Nenhuma correta" (issue #247, ponto 4): quando todas as respostas dos
// codificadores/LLM estão erradas (ex.: o robô inventou uma data que não existe
// na nota técnica), o revisor digita o valor correto.
//
// O estado (aberto + valor) vive aqui, e o pai remonta este componente via
// key={doc|campo}: navegar reseta o estado sozinho, sem reset-em-effect — o
// react-doctor só aceita key={identidade} para reset-on-prop-change.
export function CustomAnswerInput({ onSubmit }: CustomAnswerInputProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setOpen(false);
    setValue("");
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn(open && "border-brand bg-brand/10 text-brand")}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Nenhuma correta
      </Button>
      {open && (
        <div className="mt-1 flex basis-full items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-2.5 py-2">
          <Input
            autoFocus
            placeholder="Resposta correta…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="min-w-[180px] flex-1 text-sm"
          />
          <Button size="sm" disabled={!value.trim()} onClick={submit}>
            Confirmar resposta nova
          </Button>
        </div>
      )}
    </>
  );
}
