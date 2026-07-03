"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface JustificationPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
}

/**
 * Prompt de justificativa do LLM, compartilhado entre FieldCard e
 * EditFieldDialog. A condição de visibilidade (target enviado ao LLM) fica
 * nos pais — só eles conhecem/editam o `target` do campo.
 */
export function JustificationPromptField({
  value,
  onChange,
  onBlur,
}: JustificationPromptFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Prompt de justificativa do LLM (opcional)</Label>
      <p className="text-xs text-muted-foreground">
        Texto-base que o LLM recebe ao justificar este campo. Em branco, usa o
        default que exige citação textual do trecho do documento.{" "}
        <code>{"{name}"}</code> é a única chave substituída (vira o nome do
        campo); qualquer outra chave entre chaves faz o texto ser usado
        literalmente, sem substituição.
      </p>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur ? (e) => onBlur(e.target.value) : undefined}
        placeholder="Ex.: Cite o trecho do parecer e explique como ele leva à resposta."
        className="text-sm min-h-[60px] resize-y"
      />
    </div>
  );
}
