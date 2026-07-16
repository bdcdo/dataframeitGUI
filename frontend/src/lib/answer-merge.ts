// Merge das respostas submetidas sobre as já armazenadas, na fronteira de
// persistência de saveResponse.
//
// Por que isto existe (issue #484): a leitura da aba Codificar
// (analyze/code/page.tsx) descarta valores que não pertencem mais às opções
// atuais do campo — um `single` com "A" num campo cujas opções viraram
// ["X","Y"] nunca chega ao formulário. Como o formulário devolve o objeto
// inteiro e o save gravava por sobrescrita, salvar QUALQUER campo apagava do
// banco o valor que a leitura tinha descartado, sem aviso e sem histórico.
//
// A regra é separar duas perguntas que a sobrescrita fundia:
//   - persistência: "o que nós sabemos?" — o valor antigo é conhecimento e não
//     é destruído por um save que nem chegou a perguntar sobre ele;
//   - completude/automação: "o pesquisador respondeu tudo que o formulário
//     atual pergunta?" — quem decide isso continua olhando só as respostas
//     submetidas, porque um valor que o formulário atual não exibe não é
//     resposta a essa pergunta. Ver o chamador em actions/responses.ts.
//
// Chave presente em `submitted` sempre vence, inclusive com valor vazio: é
// assim que limpar um campo continua funcionando ("" para text, [] para multi).
// Chave ausente de `submitted` é preservada de `stored` — o caso da #484 e o
// dos campos que saíram do schema. A remoção legítima de condicionais ocultas
// acontece depois, no dropHiddenConditionals que roda sobre o resultado.
//
// Residual conhecido: quando o pesquisador TOCA um campo `multi` que tinha
// valores fora das opções atuais, o array submetido substitui o antigo inteiro
// e os valores invisíveis somem. Tocar o campo é ato deliberado sobre ele, e o
// tratamento honesto de campo desatualizado pertence à #216.
export function mergeSubmittedAnswers(
  stored: Record<string, unknown> | null | undefined,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  if (!stored) return submitted;
  return { ...stored, ...submitted };
}
