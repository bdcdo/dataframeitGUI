"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, FileClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CODING_DRAFT_NOTES_KEY, type CodingDraftRecovery } from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

// Faixa de recuperação do rascunho local (#608).
//
// É uma faixa, e não um toast, de propósito: o requisito é que a oferta continue
// disponível até ser resolvida. Um toast some sozinho, e um rascunho que a
// pesquisadora não viu passar é indistinguível de rascunho nenhum.
//
// O formulário abaixo dela mostra os valores DO SERVIDOR. Nada é aplicado até
// que "Retomar" seja clicado — é o que separa esta feature do auto-save que ela
// substitui, que gravava sem pedir e sem avisar.

function fieldLabel(name: string, fields: PydanticField[]): string {
  if (name === CODING_DRAFT_NOTES_KEY) return "Notas e sugestões";
  const field = fields.find((f) => f.name === name);
  return field?.description?.trim() || name;
}

// "há N minutos/horas/dias". O instante exato não ajuda a decidir; a ordem de
// grandeza sim — um rascunho de dez minutos atrás é a sessão interrompida, um de
// duas semanas provavelmente já foi superado.
function humanizeAge(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "agora há pouco";
  if (minutes < 60) return `há ${minutes} minuto${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} hora${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `há ${days} dia${days === 1 ? "" : "s"}`;
}

type DraftOffer = Extract<CodingDraftRecovery, { kind: "resumable" | "diverged" }>;

// A mensagem da oferta, numa fonte só: é renderizada duas vezes — na faixa
// visível e na região live `sr-only` — e as duas cópias não podem divergir.
function DraftOfferMessage({
  offer,
  fields,
  reference,
}: {
  offer: DraftOffer;
  fields: PydanticField[];
  reference: number;
}) {
  const overwritten = offer.kind === "diverged" ? offer.overwrittenFields : [];
  return (
    <>
      <span>
        Você tem alterações não enviadas neste documento, salvas neste navegador{" "}
        {humanizeAge(offer.updatedAt, reference)}.
      </span>

      {overwritten.length > 0 && (
        // Só o que retomar de fato sobrescreve — ver `overwrittenFields`, que é
        // a interseção e não tudo que o servidor mudou.
        <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Este documento foi salvo depois que o rascunho foi criado. Retomar
            substitui{" "}
            {overwritten.length === 1
              ? "a resposta de "
              : `as respostas de ${overwritten.length} perguntas: `}
            <strong>
              {overwritten.map((name) => fieldLabel(name, fields)).join(", ")}
            </strong>
            .
          </span>
        </div>
      )}
    </>
  );
}

// Quanto a região live espera, vazia, depois do mount antes de aceitar a
// primeira oferta, que chega no primeiro effect após o mount: criada e
// preenchida no mesmo frame, ela "nasce populada" (#635). Só a primeira oferta
// espera; a faixa visível, nunca.
export const LIVE_REGION_SETTLE_MS = 250;

interface CodingDraftBannerProps {
  recovery: CodingDraftRecovery;
  fields: PydanticField[];
  onRestore: () => void;
  onDiscard: () => void;
  /** Instante de referência da idade do rascunho. Injetável para o teste não
   *  depender do relógio real; omitido, é capturado no mount. */
  now?: number;
}

export function CodingDraftBanner({
  recovery,
  fields,
  onRestore,
  onDiscard,
  now,
}: CodingDraftBannerProps) {
  // `Date.now()` no corpo do componente é impuro no render. A idade exibida é
  // uma ordem de grandeza ("há 2 horas"), não um cronômetro: capturar o instante
  // no mount, num inicializador lazy, dá o mesmo texto sem a impureza.
  const [mountedAt] = useState(() => Date.now());
  const reference = now ?? mountedAt;

  const [regionSettled, setRegionSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setRegionSettled(true), LIVE_REGION_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);

  const offer =
    recovery.kind === "resumable" || recovery.kind === "diverged" ? recovery : null;
  const announced = regionSettled ? offer : null;

  return (
    <>
      {/* A região live fica FORA da faixa e montada sempre, vazia enquanto não
          há oferta (#635). Leitor de tela anuncia mudanças numa região que já
          existia; uma que é inserida já populada costuma ser lida como conteúdo
          estático — e a faixa, que só existe quando há oferta, nascia assim.
          Por que não resolver dentro da faixa:
          - deixar a faixa sempre montada devolve os botões para a região, ou
            obriga a região a ser só a coluna de texto, que some junto com ela;
          - `hidden` enquanto não há oferta tira a região da árvore de
            acessibilidade, e sair dele equivale a inserção;
          - uma região por frase troca o anúncio atômico das duas por dois
            anúncios em ordem imprevisível.
          O preço é o texto duplicado no DOM; `DraftOfferMessage` é a fonte
          única das duas cópias, e a visível sai da árvore de acessibilidade
          (`aria-hidden`) para o leitor não lê-la duas vezes — esta vem logo
          antes dos botões, que é onde a visível estava. Os controles ficam fora
          daqui pelo mesmo motivo do #634: dentro de live region, botão é ruído
          reanunciado. */}
      <div role="status" className="sr-only">
        {announced && (
          <DraftOfferMessage offer={announced} fields={fields} reference={reference} />
        )}
      </div>

      {offer && (
        <div className="border-b bg-amber-50 px-4 py-2.5 text-sm dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <FileClock className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <div className="flex flex-1 flex-col gap-2" aria-hidden>
              <DraftOfferMessage offer={offer} fields={fields} reference={reference} />
            </div>

            <Button size="sm" variant="default" onClick={onRestore}>
              Retomar rascunho
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              Descartar
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// Aviso separado, e permanente enquanto durar: o rascunho local não está
// funcionando neste navegador. Distinto do indicador de "não enviado", que vem
// da sujeira em memória — a tela precisa poder dizer "há trabalho pendente" E
// "não consegui guardá-lo aqui" ao mesmo tempo.
//
// Cobre duas causas com a mesma consequência: o storage não responde (janela
// anônima, quota estourada) ou o slot pertence a outra aba / a um formato que
// este build não sabe ler. Um texto só porque a ação da pesquisadora é a mesma
// nos dois casos — enviar antes de fechar; distinguir a causa na tela seria
// precisão que não muda decisão nenhuma.
export function CodingDraftUnavailableBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm"
    >
      <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
      <span>
        Não foi possível guardar uma cópia local das suas respostas neste
        navegador. Envie o documento antes de fechar a aba.
      </span>
    </div>
  );
}

// Indicador permanente de "há alterações não enviadas" (#608). Fica aqui, junto
// das outras superfícies do rascunho local, e não inline no `QuestionsPanel`:
// esse painel já é grande e o JSX condicional a mais o empurrava sobre o limiar
// de complexidade do gate.
//
// O sinal que o alimenta vem da sujeira em memória, nunca do storage — ver
// `useDirtyDocs`.
export function UnsentChangesBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      role="status"
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
      Alterações não enviadas
    </span>
  );
}
