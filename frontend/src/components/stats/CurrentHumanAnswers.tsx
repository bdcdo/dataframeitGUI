import type { CurrentHumanAnswer } from "@/lib/llm-error-metrics";

// O que cada pesquisador responde agora, ao lado do veredito anterior no card
// e no diálogo do LLM Insights. O veredito pode ser de uma arbitragem antiga,
// e quem revisa precisa ver que os pesquisadores atuais e o LLM concordam
// antes de escolher a decisão (#758).
export function CurrentHumanAnswers({ answers }: { answers: readonly CurrentHumanAnswer[] | undefined }) {
  return <div className="rounded-md border px-3 py-2">
    <p className="text-xs font-medium">Pesquisadores agora:</p>
    {answers && answers.length > 0 ? (
      <ul className="text-sm">
        {answers.map((answer, index) => (
          // Nome não é único (dois "Pesquisador" sem nome): o índice desempata.
          <li key={`${answer.name}-${index}`}>
            <span className="font-medium">{answer.name}:</span> {answer.answer || "(vazio)"}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm">(nenhuma resposta atual)</p>
    )}
  </div>;
}
