import type { Instrumentation } from "next";
import { errorCode, postgresLogFields } from "@/lib/server-error";

// Linha `[erro <código>]` que liga o código mostrado à usuária ao stack (#653;
// o porquê do código está em `errorCode`). O Next já loga o erro, mas em várias
// linhas: aqui vai tudo numa só, para `fly logs | grep <código>` trazer a
// exceção inteira. Ficam de fora os headers (cookie de sessão, JWT do Clerk) e
// a query string (token de handshake do Clerk, texto de filtro); do erro do
// Postgres vão o code, o hint e o details redigido (`postgresLogFields`).
export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  const code = errorCode(err);
  if (!code) return;
  const error = err instanceof Error ? err : undefined;
  console.error(
    `[erro ${code}] ${JSON.stringify({
      routeType: context.routeType,
      routePath: context.routePath,
      method: request.method,
      path: request.path.split("?")[0],
      message: error?.message ?? String(err),
      // O erro do Postgres que uma leitura lança como PostgrestWriteError
      // (actions/llm.ts, por exemplo) chega aqui com o code.
      ...postgresLogFields(err),
      stack: error?.stack,
    })}`,
  );
};
