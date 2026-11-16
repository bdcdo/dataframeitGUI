// Server Action que nunca resolve (fetch descartado num redeploy, conexão
// presa — #430) deixaria o `await` do envio pendurado para sempre, com o botão
// travado e nenhum aviso. `withActionTimeout` rejeita com `ActionTimeoutError`
// depois do prazo, e o `catch` do envio mostra a copy de `withErrorCode`. O
// settle tardio da action é ignorado: o usuário já foi avisado.
//
// A copy pede para recarregar, e não só para tentar de novo: o app router do
// Next roda as Server Actions de uma página uma por vez
// (`next/dist/client/components/app-router-instance.js`, `dispatchAction`), e
// um novo envio esperaria na fila atrás do que não respondeu. Recarregar
// descarta a fila.
export const ACTION_TIMEOUT_MS = 15_000;

export const ACTION_TIMEOUT_MESSAGE =
  "O servidor não respondeu. Recarregue a página e tente de novo.";

export class ActionTimeoutError extends Error {
  constructor(ms: number) {
    super(`A Server Action não respondeu em ${ms} ms`);
    this.name = "ActionTimeoutError";
  }
}

export function withActionTimeout<T>(
  promise: Promise<T>,
  ms: number = ACTION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ActionTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
