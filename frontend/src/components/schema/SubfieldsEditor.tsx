"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { OptionsEditor } from "./OptionsEditor";
import { useStableListIds } from "@/hooks/useStableListIds";
import type { SubfieldDef } from "@/lib/types";

// Patch neutro com as mesmas chaves de PydanticField: o FieldCard repassa
// direto ao updateField; o EditFieldDialog mapeia cada chave presente para o
// setter correspondente. Chave ausente = "não mexer" (por isso `in patch`
// nos consumidores, não `!== undefined`).
export interface SubfieldsPatch {
  subfields?: SubfieldDef[] | undefined;
  subfield_rule?: "all" | "at_least_one" | undefined;
  options?: string[] | null;
}

interface SubfieldsEditorProps {
  subfields: SubfieldDef[] | undefined;
  subfieldRule: "all" | "at_least_one" | undefined;
  /** Respostas padronizadas — usadas apenas quando não há subcampos. */
  options: string[];
  onChange: (patch: SubfieldsPatch) => void;
  onBeforeRemoveOption?: (opt: string) => Promise<boolean>;
}

/**
 * Bloco "Dividir em subcampos" de um campo de texto livre, compartilhado
 * entre FieldCard (editor de schema) e EditFieldDialog (Comentários / LLM
 * Insights) — o espelhamento exigido pelo CLAUDE.md fica garantido por
 * construção. Sem subcampos, o mesmo bloco oferece as respostas padronizadas.
 */
export function SubfieldsEditor({
  subfields,
  subfieldRule,
  options,
  onChange,
  onBeforeRemoveOption,
}: SubfieldsEditorProps) {
  // Keys estáveis para a lista editável de subcampos: o `key` do subfield é
  // digitado pelo usuário (muda a cada tecla), logo não serve como React key.
  const subfieldKeys = useStableListIds(subfields?.length ?? 0);
  const hasSubfields = !!subfields && subfields.length > 0;

  return (
    <div className="space-y-3">
      {/* Toggle subcampos */}
      <div className="flex items-center gap-2">
        <Switch
          checked={hasSubfields}
          onCheckedChange={(checked) => {
            if (checked) {
              onChange({
                subfields: [
                  { key: "campo_1", label: "Campo 1", required: true },
                  { key: "campo_2", label: "Campo 2", required: true },
                ],
                subfield_rule: "all",
                options: null,
              });
            } else {
              onChange({ subfields: undefined, subfield_rule: undefined });
            }
          }}
        />
        <Label className="text-xs">Dividir em subcampos</Label>
      </div>

      {hasSubfields ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Regra</Label>
            <div className="flex gap-1">
              {(
                [
                  ["all", "Todos os obrigatórios"],
                  ["at_least_one", "Pelo menos um"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "text-xs h-6",
                    (subfieldRule || "all") === value &&
                      "bg-brand/10 text-brand border-brand/40"
                  )}
                  onClick={() => onChange({ subfield_rule: value })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {subfields.map((sf, si) => (
            <div key={subfieldKeys.ids[si]} className="flex items-center gap-1.5">
              <Input
                value={sf.key}
                onChange={(e) => {
                  const sfs = [...subfields];
                  sfs[si] = { ...sfs[si], key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") };
                  onChange({ subfields: sfs });
                }}
                className="w-28 font-mono text-xs h-7"
                placeholder="chave"
              />
              <Input
                value={sf.label}
                onChange={(e) => {
                  const sfs = [...subfields];
                  sfs[si] = { ...sfs[si], label: e.target.value };
                  onChange({ subfields: sfs });
                }}
                className="flex-1 text-xs h-7"
                placeholder="Label visível"
              />
              {subfieldRule !== "at_least_one" && (
                <div className="flex items-center gap-1">
                  <Switch
                    checked={sf.required !== false}
                    onCheckedChange={(checked) => {
                      const sfs = [...subfields];
                      sfs[si] = { ...sfs[si], required: checked };
                      onChange({ subfields: sfs });
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">Obrig.</span>
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0"
                onClick={() => {
                  const sfs = subfields.filter((_, j) => j !== si);
                  subfieldKeys.removeIdAt(si);
                  onChange(
                    sfs.length > 0
                      ? { subfields: sfs }
                      : { subfields: undefined, subfield_rule: undefined },
                  );
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-6"
            onClick={() => {
              const idx = subfields.length + 1;
              subfieldKeys.appendId();
              onChange({
                subfields: [
                  ...subfields,
                  { key: `campo_${idx}`, label: `Campo ${idx}`, required: true },
                ],
              });
            }}
          >
            + Adicionar subcampo
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-xs">Respostas padronizadas (opcional)</Label>
          <p className="text-xs text-muted-foreground">
            Botões de atalho para respostas comuns. Garantem consistência na comparação.
          </p>
          <OptionsEditor
            options={options}
            onChange={(opts) => onChange({ options: opts.length > 0 ? opts : null })}
            onBeforeRemove={onBeforeRemoveOption}
          />
        </div>
      )}
    </div>
  );
}
