import type { Page } from "@playwright/test";
import { createClerkClient } from "@clerk/backend";

const REVOKE_TIMEOUT_MS = 5_000;

// O cleanup encerra a sessão pelo backend do Clerk, e não com
// `clerk.signOut({ page })`. O sign-out pela página espera `window.Clerk.loaded`
// e, depois de encerrar a sessão, navega para a rota de pós-saída e espera o
// Next renderizá-la. As duas esperas são trabalho de CPU: com a máquina
// carregada (load ~90 em 16 threads) o conjunto levou de 2,3s a 4,4s, colado
// no limite, e reprovava testes cujo corpo tinha passado. Revogar pelo backend
// é uma requisição só (0,3s a 0,65s na mesma carga) e não depende do estado da
// página. Pelo mesmo motivo não é mais preciso sair da página de análise antes
// do cleanup: o sign-out pela página travava lá no `waitForFunction` de
// `window.Clerk.loaded`.

let backend: ReturnType<typeof createClerkClient> | undefined;

function clerkBackend(): ReturnType<typeof createClerkClient> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY ausente: não há como revogar a sessão");
  }
  backend ??= createClerkClient({ secretKey });
  return backend;
}

/**
 * Id da sessão (`sid`) que o navegador deste teste usa, lido do cookie
 * `__session`. O cookie é um JWT de vida curta, mas o `sid` dentro dele é o da
 * sessão de longa duração, que é o que se revoga. A assinatura não é validada:
 * o cookie foi emitido para o próprio teste, e quem autentica a revogação é a
 * secret key.
 *
 * Revoga-se só esta sessão, e não todas as do usuário, porque o mesmo usuário
 * de teste pode estar logado em outra worktree rodando ao mesmo tempo.
 */
async function pageSessionId(page: Page, context: string): Promise<string> {
  const cookie = (await page.context().cookies()).find(
    (c) => c.name === "__session",
  );
  const payload = cookie?.value.split(".")[1];
  if (payload) {
    const { sid } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sid?: unknown };
    if (typeof sid === "string" && sid.startsWith("sess_")) return sid;
  }
  throw new Error(
    `cookie __session sem id de sessão durante cleanup (${context})`,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

async function revokeSession(sessionId: string): Promise<void> {
  const clerk = clerkBackend();
  try {
    await clerk.sessions.revokeSession(sessionId);
  } catch (error) {
    // A sessão pode já ter terminado antes do cleanup (o ticket de sign-in a
    // invalida, ou ela expirou). O objetivo do cleanup já foi alcançado, então
    // falhar aqui seria um falso erro. Só a resposta do Clerk decide isso: se a
    // consulta também falhar por outro motivo (rede, credencial), o erro da
    // revogação sobe, em vez de o cleanup passar sem ter encerrado nada.
    let status: string;
    try {
      status = (await clerk.sessions.getSession(sessionId)).status;
    } catch (lookupError) {
      if (isNotFound(error) || isNotFound(lookupError)) return;
      throw error;
    }
    if (status !== "active") return;
    throw error;
  }
}

async function revokeWithTimeout(page: Page, context: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      pageSessionId(page, context).then(revokeSession),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `revogação da sessão Clerk não concluiu em ${REVOKE_TIMEOUT_MS / 1_000}s durante cleanup (${context})`,
              ),
            ),
          REVOKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface WithClerkCleanupOptions<T> {
  page: Page;
  context: string;
  run: () => Promise<T>;
}

export async function withClerkCleanup<T>({
  page,
  context,
  run,
}: WithClerkCleanupOptions<T>): Promise<T> {
  let runFailed = false;

  try {
    return await run();
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    try {
      await revokeWithTimeout(page, context);
    } catch (cleanupError) {
      if (!runFailed) throw cleanupError;
      console.warn(
        `Cleanup Clerk falhou após erro anterior do teste (${context}):`,
        cleanupError,
      );
    }
  }
}
