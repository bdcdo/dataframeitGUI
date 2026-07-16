"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { COMPARE_READ_ONLY_REASON } from "./compare-types";

interface CustomAnswerInputProps {
  readOnly: boolean;
  // Chamado com o valor digitado quando o revisor escolhe usar uma resposta
  // nova. O pai apenas prepara o rascunho; a gravação ocorre no botão global
  // Confirmar.
  onSubmit: (value: string) => void;
  // Veredito de "resposta nova" já salvo para este doc|campo (ou null). Quando
  // presente, o botão fica destacado e o input reabre pré-preenchido — paridade
  // com Ambíguo/Pular, que refletem o veredito atual ao revisitar o campo.
  currentValue?: string | null;
  pendingValue?: string | null;
}

// "Nenhuma correta" (issue #247, ponto 4): quando todas as respostas dos
// codificadores/LLM estão erradas (ex.: o robô inventou uma data que não existe
// na nota técnica), o revisor digita o valor correto.
//
// O estado (aberto + valor) vive aqui, e o pai remonta este componente via
// key={doc|campo}: navegar reseta o estado sozinho, sem reset-em-effect — o
// react-doctor só aceita key={identidade} para reset-on-prop-change. A
// remontagem também re-semeia `value` a partir de `currentValue`, então o
// veredito salvo reaparece ao voltar ao campo sem precisar de useEffect.
export function CustomAnswerInput({
  readOnly,
  onSubmit,
  currentValue = null,
  pendingValue = null,
}: CustomAnswerInputProps) {
  const [open, setOpen] = useState(false);
  // O seed usa só `currentValue`: na montagem `pendingValue` é sempre null,
  // porque o pai reseta o rascunho no mesmo doc|campo que remonta este
  // componente (key). Após um "Usar resposta nova", `submit` sincroniza `value`
  // com o texto confirmado, então o rascunho pendente já reaparece sem o seed.
  const [value, setValue] = useState(currentValue ?? "");
  // `pendingValue` ainda destaca o botão enquanto há um rascunho custom não
  // salvo — paridade visual com Ambíguo/Pular.
  const isActive = currentValue != null || pendingValue != null;

  const submit = () => {
    if (readOnly) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setOpen(false);
    // Mantém o valor confirmado (não limpa): reabrir o input no mesmo campo
    // mostra a resposta recém-salva, consistente com o destaque do botão.
    setValue(trimmed);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn((open || isActive) && "border-brand bg-brand/10 text-brand")}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={readOnly}
        title={readOnly ? COMPARE_READ_ONLY_REASON : undefined}
      >
        Nenhuma correta
      </Button>
      {open && (
        <div className="mt-1 flex basis-full items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-2.5 py-2">
          <Input
            autoFocus
            placeholder="Resposta correta…"
            value={value}
            disabled={readOnly}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="min-w-[180px] flex-1 text-sm"
          />
          <Button
            size="sm"
            disabled={readOnly || !value.trim()}
            onClick={submit}
          >
            Usar resposta nova
          </Button>
        </div>
      )}
    </>
  );
}
