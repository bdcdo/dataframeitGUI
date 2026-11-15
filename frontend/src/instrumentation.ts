import type { Instrumentation } from "next";
import { errorCode } from "@/lib/server-error";

// Linha `[erro <código>]` que liga o código mostrado à usuária ao stack (#653;
// o porquê do código está em `errorCode`). O Next já loga o erro, mas em várias
// linhas: aqui vai tudo numa só, para `fly logs | grep <código>` trazer a
// exceção inteira. Ficam de fora os headers (cookie de sessão, JWT do Clerk) e
// a query string (token de handshake do Clerk, texto de filtro).
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
      stack: error?.stack,
    })}`,
  );
};
