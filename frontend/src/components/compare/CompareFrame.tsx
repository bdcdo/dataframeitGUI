import { CompareQueueTabs, type CompareQueueScope } from "./CompareQueueTabs";

interface CompareFrameProps {
  fullscreen: boolean;
  // Só coordenador vê o toggle de fila; em tela cheia ele some.
  showQueueTabs: boolean;
  queueValue: CompareQueueScope;
  onQueueChange: (value: CompareQueueScope) => void;
  readOnly: boolean;
  children: React.ReactNode;
}

/**
 * Moldura da Comparação, compartilhada pelo estado vazio e pela visão
 * completa: o contêiner (normal ou em tela cheia), a barra do toggle de fila e
 * o aviso de somente leitura. Extraída de `ComparePage` na decomposição do
 * container (#564).
 */
export function CompareFrame({
  fullscreen,
  showQueueTabs,
  queueValue,
  onQueueChange,
  readOnly,
  children,
}: CompareFrameProps) {
  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {showQueueTabs && !fullscreen && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <CompareQueueTabs value={queueValue} onValueChange={onQueueChange} />
        </div>
      )}
      {readOnly && (
        <output className="block shrink-0 border-b border-violet-200 bg-violet-50 px-4 py-1.5 text-center text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100">
          Visualização como outro membro: a Comparação está somente leitura.
          Volte para master para registrar vereditos, equivalências, notas ou
          sugestões e para executar LLM.
        </output>
      )}
      {children}
    </div>
  );
}
