import { toast } from "sonner";

// Feedback de um save bem-sucedido de codificação. Salvar com sucesso e
// concluir a codificação são coisas diferentes, e o toast precisa distingui-las:
// enquanto os dois casos diziam "Respostas salvas!", um envio que deixou
// obrigatórias em aberto — porque o schema mudou entre o carregamento do
// formulário e o envio — devolvia ao pesquisador o mesmo sinal de conclusão, e o
// documento reaparecia na fila depois. Quem lê isso conclui que a codificação
// não salvou (#519).
//
// `missingRequired` vem do servidor e conta o conjunto GRAVADO, não o que a tela
// mostrava; `undefined` é o caso legacy (resposta sem schema), tratado como
// completo por não haver régua a aplicar.
export function notifySaved(missingRequired: number | undefined): void {
  if (!missingRequired) {
    toast.success("Respostas salvas!");
    return;
  }
  toast.warning(
    missingRequired === 1
      ? "Salvo — o documento segue pendente (falta 1 obrigatória)"
      : `Salvo — o documento segue pendente (faltam ${missingRequired} obrigatórias)`,
  );
}
